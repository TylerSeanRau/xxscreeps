import * as C from '~/game/constants';
import * as Game from '~/game/game';
import * as Memory from '~/game/memory';
import { withOverlay } from '~/lib/schema';
import type { shape } from '~/engine/schema/creep';
import { fetchPositionArgument, Direction, RoomPosition } from '../position';
import { ConstructionSite } from './construction-site';
import { chainIntentChecks, RoomObject } from './room-object';
import { Source } from './source';
import { StructureController } from './structures/controller';
import { obstacleTypes } from '../path-finder';
import type { RoomObjectWithStore } from '../store';

export class Creep extends withOverlay<typeof shape>()(RoomObject) {
	get carry() { return this.store }
	get carryCapacity() { return this.store.getCapacity() }
	get memory() {
		const memory = Memory.get();
		const creeps = memory.creeps ?? (memory.creeps = {});
		return creeps[this.name] ?? (creeps[this.name] = {});
	}
	get my() { return this._owner === Game.me }
	get spawning() { return this._ageTime === 0 }
	get ticksToLive() { return this._ageTime - Game.time }

	build(target: ConstructionSite) {
		return chainIntentChecks(
			() => checkBuild(this, target),
			() => Game.intents.save(this, 'build', { target: target.id }));
	}

	getActiveBodyparts(type: C.BodyPart) {
		return this.body.reduce((count, part) =>
			count + (part.type === type && part.hits > 0 ? 1 : 0), 0);
	}

	harvest(target: Source) {
		return chainIntentChecks(
			() => checkHarvest(this, target),
			() => Game.intents.save(this, 'harvest', { target: target.id }));
	}

	move(direction: Direction) {
		return chainIntentChecks(
			() => checkMove(this, direction),
			() => Game.intents.save(this, 'move', { direction }));
	}

	moveTo(x: number, y: number): number;
	moveTo(pos: RoomObject | RoomPosition): number;
	moveTo(...args: [any]) {
		return chainIntentChecks(
			() => checkMoveCommon(this),
			() => {
				// Parse target
				const { pos } = fetchPositionArgument(this.pos, ...args);
				if (pos === undefined) {
					return C.ERR_INVALID_TARGET;
				} else if (pos.isNearTo(this.pos)) {
					return C.OK;
				}

				// Find a path
				const path = this.pos.findPathTo(pos);
				if (path.length === 0) {
					return C.ERR_NO_PATH;
				}

				// And move one tile
				return this.move(path[0].direction);
			});
	}

	repair() {
		return C.ERR_INVALID_TARGET;
	}

	transfer(target: RoomObjectWithStore, resourceType: C.ResourceType, amount?: number) {
		return chainIntentChecks(
			() => checkTransfer(this, target, resourceType, amount),
			() => Game.intents.save(this, 'transfer', { amount, resourceType, target: target.id }),
		);
	}

	say() {}
	upgradeController(target: StructureController) {
		return chainIntentChecks(
			() => checkUpgradeController(this, target),
			() => Game.intents.save(this, 'upgradeController', { target: target.id }),
		);
	}

	_nextPosition?: RoomPosition; // processor temporary
}

//
// Intent checks
function checkCommon(creep: Creep) {
	if (!creep.my) {
		return C.ERR_NOT_OWNER;
	} else if (creep.spawning) {
		return C.ERR_BUSY;
	}
	return C.OK;
}

export function checkBuild(creep: Creep, target?: ConstructionSite) {
	return chainIntentChecks(
		() => checkCommon(creep),
		() => {
			if (creep.getActiveBodyparts(C.WORK) <= 0) {
				return C.ERR_NO_BODYPART;

			} else if (creep.carry.energy <= 0) {
				return C.ERR_NOT_ENOUGH_RESOURCES;

			} else if (!(target instanceof ConstructionSite)) {
				return C.ERR_INVALID_TARGET;

			} else if (!creep.pos.inRangeTo(target, 3)) {
				return C.ERR_NOT_IN_RANGE;
			}

			// A friendly creep sitting on top of a construction site for an obstacle structure prevents
			// `build`
			const { room } = target;
			if (obstacleTypes.has(target.structureType)) {
				const creepFilter = room.controller?.safeMode === undefined ? () => true : (creep: Creep) => creep.my;
				for (const creep of room.find(C.FIND_CREEPS)) {
					if (target.pos.isEqualTo(creep) && creepFilter(creep)) {
						return C.ERR_INVALID_TARGET;
					}
				}
			}
			return C.OK;
		});
}

export function checkHarvest(creep: Creep, target?: RoomObject) {
	return chainIntentChecks(
		() => checkCommon(creep),
		() => {
			if (creep.getActiveBodyparts(C.WORK) <= 0) {
				return C.ERR_NO_BODYPART;

			} else if (!(target instanceof RoomObject)) {
				return C.ERR_INVALID_TARGET;

			} else if (!creep.pos.isNearTo(target.pos)) {
				return C.ERR_NOT_IN_RANGE;
			}

			if (target instanceof Source) {
				if (target.energy <= 0) {
					return C.ERR_NOT_ENOUGH_RESOURCES;
				}
				return C.OK;
			}
			return C.ERR_INVALID_TARGET;
		});
}

export function checkMove(creep: Creep, direction: number) {
	return chainIntentChecks(
		() => checkMoveCommon(creep),
		() => {
			if (!(direction >= 1 && direction <= 8) && Number.isInteger(direction)) {
				return C.ERR_INVALID_ARGS;
			}
			return C.OK;
		},
	);
}

function checkMoveCommon(creep: Creep) {
	return chainIntentChecks(
		() => checkCommon(creep),
		() => {
			if (creep.fatigue > 0) {
				return C.ERR_TIRED;
			} else if (creep.getActiveBodyparts(C.MOVE) <= 0) {
				return C.ERR_NO_BODYPART;
			}
			return C.OK;
		});
}

export function checkTransfer(
	creep: Creep,
	target: RoomObject & Partial<RoomObjectWithStore> | undefined,
	resourceType: C.ResourceType,
	amount?: number,
) {
	return chainIntentChecks(
		() => checkCommon(creep),
		() => {
			if (amount! < 0) {
				return C.ERR_INVALID_ARGS;

			} else if (!C.RESOURCES_ALL.includes(resourceType)) {
				return C.ERR_INVALID_ARGS;

			} else if (!(creep instanceof Creep) || !(target instanceof RoomObject)) {
				return C.ERR_INVALID_TARGET;

			} else if (target instanceof Creep && target.spawning) {
				return C.ERR_INVALID_TARGET;

			} else if (!target.store) {
				return C.ERR_INVALID_TARGET;
			}

			const targetCapacity = target.store.getCapacity(resourceType);
			if (targetCapacity === null) {
				return C.ERR_INVALID_TARGET;
			}

			if (!creep.pos.isNearTo(target.pos)) {
				return C.ERR_NOT_IN_RANGE;

			} else if (!(creep.store[resourceType]! >= 0)) {
				return C.ERR_NOT_ENOUGH_RESOURCES;
			}

			const targetFreeCapacity = target.store.getFreeCapacity(resourceType);
			if (!(targetFreeCapacity > 0)) {
				return C.ERR_FULL;
			}

			let tryAmount = amount;
			// eslint-disable-next-line @typescript-eslint/strict-boolean-expressions
			if (!tryAmount) {
				tryAmount = Math.min(creep.store[resourceType]!, targetFreeCapacity);
			}

			if (!(tryAmount <= creep.store[resourceType]!)) {
				return C.ERR_NOT_ENOUGH_RESOURCES;
			}

			if (!(tryAmount <= targetFreeCapacity)) {
				return C.ERR_FULL;
			}

			return C.OK;
		});
}

export function checkUpgradeController(creep: Creep, target: StructureController) {
	return chainIntentChecks(
		() => checkCommon(creep),
		() => {
			if (creep.getActiveBodyparts(C.WORK) <= 0) {
				return C.ERR_NO_BODYPART;

			} else if (creep.store.energy <= 0) {
				return C.ERR_NOT_ENOUGH_RESOURCES;

			} else if (!(target instanceof StructureController)) {
				return C.ERR_INVALID_TARGET;

			} else if (target.upgradeBlocked! > 0) {
				return C.ERR_INVALID_TARGET;

			} else if (!creep.pos.inRangeTo(target.pos, 3)) {
				return C.ERR_NOT_IN_RANGE;

			} else if (!target.my) {
				return C.ERR_NOT_OWNER;
			}

			return C.OK;
		});
}
