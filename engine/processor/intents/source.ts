import { bindProcessor } from '~/engine/processor/bind';
import { Source, nextRegenerationTime } from '~/engine/game/objects/source';

function process(this: Source) {
	if (this.energy < this.energyCapacity) {
		if (this[nextRegenerationTime] === 0) {
			this[nextRegenerationTime] = Game.time + 1000;
		} else if (this.ticksToRegeneration === 0) {
			this.energy = this.energyCapacity;
		}
	}
}

export default () => bindProcessor(Source, { process });
