import { Worker, isMainThread, parentPort } from 'worker_threads';
import { PubsubListener, PubsubProvider, PubsubSubscription } from '../provider';
import { listen, staticCast } from 'xxscreeps/util/utility';

type Listener = (message: string, id?: string) => void;
type Subscription = {
	readonly name: string;
	readonly listener: Listener;
};

type PubsubMessage = {
	type: 'pubsubMessage';
	name: string;
	message: string;
	id?: string;
};
type SubscriptionRequest = {
	type: 'pubsubSubscribe';
	name: string;
	id: string;
};
type SubscriptionConfirmation = {
	type: 'pubsubSubscribed';
	id: string;
};
type UnsubscribeRequest = {
	type: 'pubsubUnsubscribe';
	name: string;
	id: string;
};

type UnknownMessage = { type: null };
type MasterMessage = PubsubMessage | SubscriptionConfirmation | UnknownMessage;
type WorkerMessage = PubsubMessage | SubscriptionRequest | UnsubscribeRequest | UnknownMessage;

/**
 * Utility functions to manage subscriptions in a single isolate
 */
const subscriptionsByName = new Map<string, Set<Subscription>>();

function connect(subscription: Subscription) {
	const pubsubs = subscriptionsByName.get(subscription.name);
	if (pubsubs) {
		pubsubs.add(subscription);
	} else {
		subscriptionsByName.set(subscription.name, new Set([ subscription ]));
	}
}

function disconnect(pubsub: Subscription) {
	const pubsubs = subscriptionsByName.get(pubsub.name)!;
	pubsubs.delete(pubsub);
	if (pubsubs.size === 0) {
		subscriptionsByName.delete(pubsub.name);
	}
}

function publish(name: string, message: string, id?: string) {
	const pubsubs = subscriptionsByName.get(name);
	if (pubsubs !== undefined) {
		for (const pubsub of pubsubs) {
			pubsub.listener(message, id);
		}
	}
}

/**
 * Common classes for parent / worker threads
 */
export abstract class LocalPubsubProvider implements PubsubProvider {
	abstract disconnect(): void;
	abstract publish(key: string, message: string): Promise<void>;
	abstract subscribe(key: string, listener: (message: string) => void): Promise<PubsubSubscription>;

	constructor(protected readonly name: string) {}

	static connect(name: string) {
		return new (isMainThread ? LocalPubsubProviderParent : LocalPubsubProviderWorker)(name);
	}

	static initializeWorker(worker: Worker) {
		LocalPubsubProviderParent.initializeWorker(worker);
	}
}

abstract class LocalPubsubSubscription implements PubsubSubscription {
	abstract publish(message: string): Promise<void>;

	readonly listener: Listener;
	readonly id = `${Math.floor(Math.random() * 2 ** 52).toString(16)}`;

	constructor(readonly name: string, listener: PubsubListener) {
		connect(this);
		this.listener = (message, id) => {
			if (this.id !== id) {
				listener(message);
			}
		};
	}

	disconnect() {
		disconnect(this);
	}
}

/**
 * Subscriptions created within the master process
 */
class LocalPubsubProviderParent extends LocalPubsubProvider {

	// Install listener on newly created workers. Called from the host/parent thread.
	static initializeWorker(worker: Worker) {
		const idsByName = new Map<string, Set<string>>();
		const localSubscriptions = new Map<string, Subscription>();
		worker.on('message', (message: WorkerMessage) => {
			switch (message.type) {
				case 'pubsubMessage':
					// Child sent message to the main thread
					return publish(message.name, message.message, message.id);

				case 'pubsubSubscribe': {
					const pubsubIds = idsByName.get(message.name);
					if (pubsubIds) {
						// This worker is already subscribed to this pubsub.. just add another local reference
						pubsubIds.add(message.id);
					} else {
						// Set up a new subscription for this worker
						const { name } = message;
						const pubsubIds = new Set([ message.id ]);
						idsByName.set(name, pubsubIds);
						const subscription: Subscription = {
							name,
							listener: (message, id) => {
								if (id === undefined || pubsubIds.size > 1 || !pubsubIds.has(id)) {
									worker.postMessage(staticCast<MasterMessage>({
										type: 'pubsubMessage',
										name, message, id,
									}));
								}
							},
						};
						connect(subscription);
						localSubscriptions.set(name, subscription);
					}
					// Send notification to child that the subscription is ready
					worker.postMessage(staticCast<MasterMessage>({
						type: 'pubsubSubscribed',
						id: message.id,
					}));
					break;
				}

				case 'pubsubUnsubscribe': {
					const { name } = message;
					const subscriptionIds = idsByName.get(name)!;
					subscriptionIds.delete(message.id);
					if (subscriptionIds.size === 0) {
						const pubsub = localSubscriptions.get(name)!;
						localSubscriptions.delete(name);
						disconnect(pubsub);
					}
					break;
				}

				default:
			}
		});

		// If the worker exits ungracefully then clean up all dangling subscriptions
		worker.on('exit', () => {
			for (const pubsub of localSubscriptions.values()) {
				disconnect(pubsub);
			}
			idsByName.clear();
			localSubscriptions.clear();
		});

		return worker;
	}

	disconnect() {}

	publish(name: string, message: string) {
		publish(`${this.name}/${name}`, message);
		return Promise.resolve();
	}

	subscribe(key: string, listener: PubsubListener) {
		return Promise.resolve(new ParentSubscription(`${this.name}/${key}`, listener));
	}
}


class ParentSubscription extends LocalPubsubSubscription {
	publish(message: string) {
		publish(this.name, message, this.id);
		return Promise.resolve();
	}
}

/**
 * Subscriptions within a worker_thread
 */
let parentRefs = 0;

class LocalPubsubProviderWorker extends LocalPubsubProvider {
	private static didInit = false;

	// Install listener for all pubsubs in this thread
	private static initializeThisWorker() {
		if (LocalPubsubProviderWorker.didInit) {
			return;
		}
		LocalPubsubProviderWorker.didInit = true;
		parentPort!.on('message', (message: MasterMessage) => {
			if (message.type === 'pubsubMessage') {
				publish(message.name, message.message, message.id);
			}
		});
	}

	disconnect() {}

	publish(key: string, message: string) {
		parentPort!.postMessage(staticCast<WorkerMessage>({
			type: 'pubsubMessage',
			name: `${this.name}/${key}`,
			message,
		}));
		return Promise.resolve();
	}

	subscribe(key: string, listener: PubsubListener) {
		LocalPubsubProviderWorker.initializeThisWorker();
		const subscription = new WorkerSubscription(`${this.name}/${key}`, listener);
		if (++parentRefs === 1) {
			parentPort!.ref();
		}
		// Send connection notification to parent
		return new Promise<WorkerSubscription>(resolve => {
			const unlisten = listen(parentPort!, 'message', (message: MasterMessage) => {
				if (message.type === 'pubsubSubscribed' && message.id === subscription.id) {
					unlisten();
					connect(subscription);
					resolve(subscription);
				}
			});
			parentPort!.postMessage(staticCast<WorkerMessage>({
				type: 'pubsubSubscribe',
				name: subscription.name,
				id: subscription.id,
			}));
		});
	}
}

class WorkerSubscription extends LocalPubsubSubscription {
	disconnect() {
		super.disconnect();
		parentPort!.postMessage(staticCast<WorkerMessage>({
			type: 'pubsubUnsubscribe',
			name: this.name,
			id: this.id,
		}));
		if (--parentRefs === 0) {
			parentPort!.unref();
		}
	}

	publish(message: string) {
		parentPort!.postMessage(staticCast<WorkerMessage>({
			type: 'pubsubMessage',
			name: this.name,
			message,
			id: this.id,
		}));
		return Promise.resolve();
	}
}