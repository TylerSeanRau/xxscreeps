import type { KeysOf, KeyFor } from 'xxscreeps/utility/types';
import type { Room } from './room';
import * as C from 'xxscreeps/game/constants';
import { lookFor } from './methods';
import { findHandlers } from './symbols';
import './exit';

// Registers a FIND_ constant and its respective handler
export type FindHandler = (room: Room) => any[];
type FindHandlers = Exclude<Find[keyof Find], void>;
export type FindConstants = KeysOf<FindHandlers>;
export { findHandlers };
export function registerFindHandlers<Find extends { [find: number]: FindHandler }>(handlers: Find): void | Find {
	for (const key in handlers) {
		findHandlers.set(Number(key), handlers[key]);
	}
}

// Built-in FIND_ handlers
const builtinFind = registerFindHandlers({
	// Creeps
	[C.FIND_CREEPS]: room => lookFor(room, C.LOOK_CREEPS),
	[C.FIND_MY_CREEPS]: room => lookFor(room, C.LOOK_CREEPS).filter(creep => creep.my),
	[C.FIND_HOSTILE_CREEPS]: room => lookFor(room, C.LOOK_CREEPS).filter(creep => !creep.my),
});
export interface Find { builtin: typeof builtinFind }

// Convert a FIND_ constant to result type
export type FindType<Find extends FindConstants> = ReturnType<KeyFor<FindHandlers, Find>>[number];