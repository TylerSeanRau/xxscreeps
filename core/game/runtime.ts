import type { Game } from './state';
import { globals } from './symbols';

import lodash from 'lodash';
import * as C from './constants';
import * as Memory from './memory';

// `Memory` is a getter/setter
export function registerGlobal(name: string, value: any): void;
export function registerGlobal(fn: Function): void;
export function registerGlobal(...args: [ string, any ] | [ Function ]) {
	const { name, value } = args.length === 1 ?
		{ name: args[0].name, value: args[0] } :
		{ name: args[0], value: args[1] };
	globals[name] = value;
}

export function setupGlobals(globalThis: any) {

	// Global lodash compatibility
	globalThis._ = lodash;

	// Exported globals, `registerGlobal`
	for (const [ key, object ] of Object.entries(globals)) {
		globalThis[key] = object;
	}

	// Export constants
	for (const [ identifier, value ] of Object.entries(C)) {
		globalThis[identifier] = value;
	}

	// Memory
	Object.defineProperty(globalThis, 'Memory', {
		enumerable: true,
		get: Memory.get,
		set: Memory.set,
	});

	// Not implemented
	globalThis.Mineral = function() {};
	globalThis.StructureLink = function() {};
	globalThis.StructureObserver = function() {};
	globalThis.StructureTerminal = function() {};
	globalThis.Tombstone = function() {};
}

// Used to extract type information from bundled dts file, via make-types.ts
export interface Global {
	Game: Game;
	Memory: any;
	console: Console;
}
export function globalNames() {
	return [ 'Game', 'Memory', 'console', ...Object.keys(globals) ];
}
export function globalTypes(): Global {
	return undefined as never;
}