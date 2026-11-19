import IdkType from '#/cache/config/IdkType.js';
import Player from '#/engine/entity/Player.js';
import IdkSaveDesign from '#/network/game/client/model/IdkSaveDesign.js';

const MAN_HAIR_IDS = [0, 1, 2, 3, 4, 5, 6, 7, 8];
const MAN_JAW_IDS = [10, 11, 12, 13, 14, 15, 16, 17];
const MAN_TORSO_IDS = [18, 19, 20, 21, 22, 23, 24, 25];
const MAN_ARMS_IDS = [26, 27, 28, 29, 30, 31];
const MAN_HANDS_IDS = [33, 34];
const MAN_LEGS_IDS = [36, 37, 38, 39, 40];
const MAN_FEET_IDS = [42, 43];
const WOMAN_HAIR_IDS = [45, 46, 47, 48, 49, 50, 51, 52, 53, 54];
const WOMAN_TORSO_IDS = [56, 57, 58, 59, 60];
const WOMAN_ARMS_IDS = [61, 62, 63, 64, 65];
const WOMAN_HANDS_IDS = [67, 68];
const WOMAN_FEET_IDS = [79, 80];
const WOMAN_LEGS_IDS = [70, 71, 72, 73, 74, 75, 76, 77];

function pick<T>(arr: T[]): T {
    return arr[Math.floor(Math.random() * arr.length)];
}

function pickIdkit(ids: number[], type: number): number {
    const valid = ids.filter(id => {
        const idk = IdkType.get(id);
        return idk && !idk.disable && idk.type === type;
    });

    if (valid.length === 0) {
        throw new Error(`No valid idkits for type ${type}`);
    }

    return pick(valid);
}

export function randomBotDesign(): IdkSaveDesign {
    const gender = Math.random() < 0.51 ? 0 : 1;
    const kits = gender === 0
        ? [MAN_HAIR_IDS, MAN_JAW_IDS, MAN_TORSO_IDS, MAN_ARMS_IDS, MAN_HANDS_IDS, MAN_LEGS_IDS, MAN_FEET_IDS]
        : [WOMAN_HAIR_IDS, [], WOMAN_TORSO_IDS, WOMAN_ARMS_IDS, WOMAN_HANDS_IDS, WOMAN_LEGS_IDS, WOMAN_FEET_IDS];
    const idkit = kits.map((ids, slot) => gender === 1 && slot === 1 ? -1 : pickIdkit(ids, slot + gender * 7));
    const colors = Player.DESIGN_BODY_COLORS.map(palette => Math.floor(Math.random() * palette.length));
    return new IdkSaveDesign(gender, idkit, colors);
}
