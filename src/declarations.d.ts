declare module 'acorn-class-fields';
declare module 'acorn-private-methods';
declare module 'stream-to-promise' {
	import type * as Stream from 'stream';

	export default function streamToPromise(stream: NodeJS.ReadableStream | Stream.Readable): Promise<Buffer>;
	export default function streamToPromise(stream: NodeJS.WritableStream | Stream.Writable): Promise<void>;
}

interface ImportMeta {
	resolve(specifier: string, parent?: string): Promise<string>;
}

interface Function {
	displayName: string;
}
