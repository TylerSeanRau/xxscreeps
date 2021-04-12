import * as C from 'xxscreeps/game/constants';
import * as Game from 'xxscreeps/game';
import * as Fn from 'xxscreeps/utility/functional';
import * as Creep from 'xxscreeps/mods/creep/creep';
import * as StoreIntent from 'xxscreeps/mods/resource/processor/store';
import { getPositonInDirection, Direction } from 'xxscreeps/game/position';
import { insertObject, moveObject } from 'xxscreeps/game/room/methods';
import { registerIntentProcessor, registerObjectTickProcessor } from 'xxscreeps/processor';
import { Owner, RoomObject } from 'xxscreeps/game/object';
import { ALL_DIRECTIONS } from 'xxscreeps/game/position/direction';
import { makePositionChecker } from 'xxscreeps/game/path-finder/obstacle';
import { StructureExtension } from './extension';
import { checkSpawnCreep, StructureSpawn, SpawnTime } from './spawn';

declare module 'xxscreeps/processor' {
	interface Intent { spawn: typeof intent }
}
const intent = registerIntentProcessor(StructureSpawn, 'spawn',
(spawn, context, body: Creep.PartType[], name: string, energyStructureIds: string[] | null, directions: Direction[] | null) => {

	// Get energy structures
	const energyStructures = function() {
		const filter = (structure?: RoomObject): structure is StructureExtension | StructureSpawn =>
			structure instanceof StructureExtension || structure instanceof StructureSpawn;
		if (energyStructureIds) {
			return energyStructureIds.map(id => Game.getObjectById(id)).filter(filter);
		} else {
			const structures = spawn.room.find(C.FIND_STRUCTURES).filter(filter);
			return structures.sort((left, right) =>
				(left.structureType === 'extension' ? 1 : 0) - (right.structureType === 'extension' ? 1 : 0) ||
				left.pos.getRangeTo(spawn.pos) - right.pos.getRangeTo(spawn.pos));
		}
	}();

	// Is this intent valid?
	const canBuild = checkSpawnCreep(spawn, body, name, directions, energyStructures) === C.OK;
	if (!canBuild) {
		return false;
	}

	// Withdraw energy
	let cost = Fn.accumulate(body, part => C.BODYPART_COST[part]);
	for (const structure of energyStructures) {
		const energyToSpend = Math.min(cost, structure.energy);
		StoreIntent.subtract(structure.store, 'energy', energyToSpend);
		cost -= energyToSpend;
		if (cost === 0) {
			break;
		}
	}

	// Add new creep to room objects
	const creep = Creep.create(spawn.pos, body, name, Game.me);
	insertObject(spawn.room, creep);

	// Set spawning information
	const needTime = body.length * C.CREEP_SPAWN_TIME;
	spawn.spawning = {
		creep: creep.id,
		directions: directions ?? [],
		needTime,
		[SpawnTime]: Game.time + needTime,
	};
	context.didUpdate();
});

registerObjectTickProcessor(StructureSpawn, (spawn, context) => {

	// Check creep spawning
	(() => {
		if (spawn.spawning && spawn.spawning[SpawnTime] <= Game.time) {
			const creep = Game.getObjectById(spawn.spawning.creep);
			if (creep && creep instanceof Creep.Creep) {
				// Look for spawn direction
				const check = makePositionChecker({
					room: spawn.room,
					type: 'creep',
					user: creep[Owner],
				});
				const directions = new Set(spawn.spawning.directions.length === 0 ?
					ALL_DIRECTIONS : spawn.spawning.directions as Direction[]);
				const direction = Fn.firstMatching(directions, direction => check(getPositonInDirection(creep.pos, direction)));

				// If no direction was found then defer this creep
				// TODO: Spawn stomp hostile creeps
				if (direction === undefined) {
					spawn.spawning[SpawnTime] = Game.time + 1;
					return;
				}

				// Creep can be spawned
				const hasClaim = creep.body.some(part => part.type === C.CLAIM);
				creep._ageTime = Game.time + (hasClaim ? C.CREEP_CLAIM_LIFE_TIME : C.CREEP_LIFE_TIME);
				moveObject(creep, getPositonInDirection(creep.pos, direction));
			}
			spawn.spawning = undefined;
			context.setActive();
		}
	})();

	// Add 1 energy per tick to spawns in low energy rooms
	if (spawn.room.energyAvailable < C.SPAWN_ENERGY_CAPACITY && spawn.store.energy < C.SPAWN_ENERGY_CAPACITY) {
		StoreIntent.add(spawn.store, C.RESOURCE_ENERGY, 1);
		context.setActive();
	}

	// TODO: This is just a convenient place to keep controlled rooms unidle until I have a more sophisticated solution
	context.setActive();
});