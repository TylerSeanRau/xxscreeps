import { promises as fs } from 'fs';
import * as Fn from 'xxscreeps/utility/functional';
import * as Path from 'path';
import { listen } from 'xxscreeps/utility/async';
import type { PersistenceProvider } from '../provider';
import { create, connect, Responder, ResponderClient, ResponderHost } from './responder';

const fragmentNameWhitelist = /^[a-zA-Z0-9/-]+$/;

function copy(buffer: Readonly<Uint8Array>) {
	const copy = new Uint8Array(new SharedArrayBuffer(buffer.length));
	copy.set(buffer);
	return copy;
}

export abstract class LocalPersistenceProvider extends Responder implements PersistenceProvider {
	abstract del(key: string): Promise<void>;
	abstract get(key: string): Promise<Readonly<Uint8Array>>;
	abstract set(key: string, value: Readonly<Uint8Array>): Promise<void>;
	abstract copy(from: string, to: string): Promise<void>;
	abstract save(): Promise<void>;

	static async create(path: string) {
		// Ensure directory exists, or make it
		try {
			await fs.mkdir(path);
		} catch (err) {}
		const dir = await fs.opendir(path);
		await dir.close();

		// Lock file maker
		const lockFile = Path.join(path, '.lock');
		const tryLock = async() => {
			const file = await fs.open(lockFile, 'wx');
			await file.write(`${process.pid}`);
			await file.close();
		};

		await (async() => {
			// Try lock
			try {
				await tryLock();
				return;
			} catch (err) {}

			// On failure get locked pid
			const pid = await async function() {
				try {
					return JSON.parse(await fs.readFile(lockFile, 'utf8'));
				} catch (err) {
					// Lock format unrecognized
				}
			}();

			// See if process still exists
			if (pid !== undefined) {
				const exists = function() {
					try {
						process.kill(pid, 0); // does *not* kill the process, just tries to send a signal
						return true;
					} catch (err) {
						return false;
					}
				}();
				if (exists) {
					throw new Error(`pid ${pid} has locked ${path}`);
				}
			}

			// The lock is dead and can be removed
			// nb: This unlink is definitely a race condition
			await fs.unlink(lockFile);

			// Try once more
			await tryLock();
		})();
		return create(LocalPersistenceHost, `persistence://${path}`, path);
	}

	static connect(path: string) {
		return connect(LocalPersistenceClient, `persistence://${path}`);
	}
}

class LocalPersistenceHost extends ResponderHost(LocalPersistenceProvider) {
	private bufferedBlobs = new Map<string, Readonly<Uint8Array>>();
	private bufferedDeletes = new Set<string>();
	private readonly knownPaths = new Set<string>();
	private readonly processUnlistener = listen(process, 'exit', () => this.checkMissingFlush());

	constructor(name: string, private readonly path: string) {
		super(name);
	}

	async del(key: string) {
		this.check(key);
		// If it hasn't been written to disk yet it will just be removed from the buffer
		if (this.bufferedBlobs.has(key)) {
			this.bufferedBlobs.delete(key);
		} else {
			// Ensure it actually exists on disk
			const path = Path.join(this.path, key);
			await fs.stat(path);
			this.bufferedDeletes.add(key);
		}
		return Promise.resolve();
	}

	async get(key: string): Promise<Readonly<Uint8Array>> {
		this.check(key);
		// Check in-memory buffer
		const buffered = this.bufferedBlobs.get(key);
		if (buffered !== undefined) {
			return buffered;
		} else if (this.bufferedDeletes.has(key)) {
			throw new Error('Does not exist');
		}
		// Load from file system
		const path = Path.join(this.path, key);
		const handle = await fs.open(path, 'r');

		try {
			const { size } = await handle.stat();
			const buffer = new Uint8Array(new SharedArrayBuffer(size));
			if ((await handle.read(buffer, 0, size)).bytesRead !== size) {
				throw new Error('Read partial file');
			}
			return buffer;
		} finally {
			await handle.close();
		}
	}


	set(key: string, value: Readonly<Uint8Array>) {
		this.check(key);
		this.bufferedDeletes.delete(key);
		this.bufferedBlobs.set(key, value.buffer instanceof SharedArrayBuffer ? value : copy(value));
		return Promise.resolve();
	}

	async copy(from: string, to: string) {
		this.check(to);
		this.bufferedBlobs.set(to, await this.get(from));
	}

	async save() {
		// Reset buffers
		const blobs = this.bufferedBlobs;
		const deletes = this.bufferedDeletes;
		this.bufferedBlobs = new Map;
		this.bufferedDeletes = new Set;

		// Run saves and deletes in parallel
		await Promise.all([

			// Saves all buffered data to disk
			await Promise.all(Fn.map(blobs.entries(), async([ fragment, blob ]) => {
				const path = Path.join(this.path, fragment);
				const dirname = Path.dirname(path);
				if (!this.knownPaths.has(dirname)) {
					try {
						await fs.mkdir(dirname, { recursive: true });
					} catch (err) {
						if (err.code !== 'EEXIST') {
							throw err;
						}
					}
					this.knownPaths.add(dirname);
				}
				await fs.writeFile(path, blob as Uint8Array);
			})),

			// Dispatches buffered deletes
			await Promise.all(Fn.map(deletes.values(), async fragment => {
				const path = Path.join(this.path, fragment);
				await fs.unlink(path);
			})),
		]);

		// Also remove empty directories after everything has flushed
		const unlinkedDirectories = new Set<string>();
		await Promise.all(Fn.map(deletes.values(), async fragment => {
			const path = Path.join(this.path, fragment);
			for (let dir = Path.dirname(path); dir !== this.path; dir = Path.dirname(dir)) {
				if (unlinkedDirectories.has(dir)) {
					break;
				}
				try {
					unlinkedDirectories.add(dir);
					await fs.rmdir(dir);
					this.knownPaths.delete(dir);
				} catch (err) {
					break;
				}
			}
		}));
	}

	destroyed() {
		this.processUnlistener();
		this.checkMissingFlush();
		fs.unlink(Path.join(this.path, '.lock')).catch(() => {});
	}

	private check(fragment: string) {
		// Safety check before writing random file names based on user input
		if (!fragmentNameWhitelist.test(fragment)) {
			throw new Error(`Unsafe blob id: ${fragment}`);
		}
	}

	private checkMissingFlush() {
		const size = this.bufferedBlobs.size + this.bufferedDeletes.size;
		if (size !== 0) {
			console.warn(`Blob storage shut down with ${size} pending write(s)`);
		}
	}
}

class LocalPersistenceClient extends ResponderClient(LocalPersistenceProvider) {
	del(key: string) {
		return this.request('del', key);
	}

	get(key: string) {
		return this.request('get', key);
	}

	set(key: string, value: Readonly<Uint8Array>) {
		return this.request('set', key, value);
	}

	copy(from: string, to: string) {
		return this.request('copy', from, to);
	}

	save() {
		return this.request('save');
	}
}