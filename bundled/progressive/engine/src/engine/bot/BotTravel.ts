import { isInside, KARAMJA_POLYGON } from '#/engine/bot/BotRegions.js';
import type Player from '#/engine/entity/Player.js';
import type { BotPlayer } from '#/engine/bot/BotPlayer.js';
import NpcType from '#/cache/config/NpcType.js';
import LocType from '#/cache/config/LocType.js';
import InvType from '#/cache/config/InvType.js';
import ObjType from '#/cache/config/ObjType.js';
import ParamType from '#/cache/config/ParamType.js';
import { ParamHelper } from '#/cache/config/ParamHelper.js';
import VarPlayerType from '#/cache/config/VarPlayerType.js';
import World from '#/engine/World.js';
import Environment from '#/util/Environment.js';
import { Interaction } from '#/engine/entity/Interaction.js';
import ServerTriggerType from '#/engine/script/ServerTriggerType.js';
import { PlayerStat } from '#/engine/entity/PlayerStat.js';
import { FOOD_IDS } from '#/engine/bot/BotKnowledge.js';
import { botWalkPath, findPathToEntity } from '#/engine/GameMap.js';
import { findLocApproach, trimPathAtCsvBlock } from '#/engine/bot/BotNavigation.js';
import { answerBotDialogue } from '#/engine/bot/BotDialogue.js';
import { BotLog } from '#/engine/bot/BotLog.js';

type Point = { x: number; z: number; level: number };
export type TravelLeg = {
    id: string;
    kind: 'ship' | 'tunnel';
    from: Point;
    to: Point;
    fare: number;
    npc?: string;
    loc?: string;
};
const point = (x: number, z: number, level = 0): Point => ({ x, z, level });
export const TRAVEL_LEGS: Record<string, TravelLeg> = {
    sarim: {
        id: 'sarim-karamja',
        kind: 'ship',
        from: point(3028, 3217),
        to: point(2956, 3143, 1),
        fare: 30,
        npc: 'captain_tobias'
    },
    karamja: {
        id: 'karamja-sarim',
        kind: 'ship',
        from: point(2954, 3147),
        to: point(3032, 3217, 1),
        fare: 30,
        npc: 'customs_officer'
    },
    ardougne: {
        id: 'ardougne-brimhaven',
        kind: 'ship',
        from: point(2679, 3275),
        to: point(2775, 3234, 1),
        fare: 30,
        npc: 'captain_barnaby'
    },
    brimhaven: {
        id: 'brimhaven-ardougne',
        kind: 'ship',
        from: point(2772, 3230),
        to: point(2683, 3268, 1),
        fare: 30,
        npc: 'customs_officer'
    },
    tunnelWest: {
        id: 'tunnel-west',
        kind: 'tunnel',
        from: point(2876, 3480),
        to: point(2820, 9882),
        fare: 0,
        loc: 'tunnelstairstop2'
    },
    tunnelEast: {
        id: 'tunnel-east',
        kind: 'tunnel',
        from: point(2820, 3484),
        to: point(2876, 9878),
        fare: 0,
        loc: 'tunnelstairstop'
    }
};
const bot = (p: Player) => (p as Player & { _bot?: BotPlayer })._bot;
export function carriedCoins(p: Player): number {
    return (p.getInventory(InvType.INV)?.items ?? []).reduce((s, i) => s + (i?.id === 995 ? i.count : 0), 0);
}
export function tunnelAvailable(p: Player): boolean {
    const id = VarPlayerType.getId('fishingcompo');
    return Environment.NODE_MEMBERS && id !== -1 && p.vars[id] === 5;
}
export function onKaramja(x: number, z: number): boolean {
    return isInside(KARAMJA_POLYGON, x, z);
}
/** Continuous exposure estimate, not a combat-level eligibility threshold. */
export function travelCondition(p: Player) {
    const weights = bot(p)?.planner.personality.weights ?? {};
    const combatWeight = ['ATTACK', 'STRENGTH', 'DEFENCE', 'RANGED', 'MAGIC'].reduce((s, k) => s + (weights[k] ?? 0), 0);
    const appetite =
        combatWeight /
        Math.max(
            1,
            Object.values(weights).reduce<number>((s, v) => s + (v ?? 0), 0)
        );
    let armour = 0;
    const param = ParamType.getId('stabdefence');
    for (const item of p.getInventory(InvType.WORN)?.items ?? []) if (item && param !== -1) armour += ParamHelper.getIntParam(param, ObjType.get(item.id), 0);
    const food = (p.getInventory(InvType.INV)?.items ?? []).reduce((s, i) => s + (i && FOOD_IDS.includes(i.id) ? Math.min(i.count, 28) * 3 : 0), 0);
    const hp = p.levels[PlayerStat.HITPOINTS];
    const damage = 90 / (1 + p.getCombatLevel() / 20 + p.levels[PlayerStat.DEFENCE] / 20 + Math.max(0, armour) / 60);
    return {
        appetite,
        armour,
        food,
        hp,
        damage,
        safeToWalk: damage <= (hp + food * 0.6) * (0.8 + appetite),
        speed: 1 + (p.runenergy / 10000) * 0.6 + p.baseLevels[PlayerStat.AGILITY] / 500
    };
}
const homes = new WeakMap<Player, boolean>();
export function chooseTravel(p: Player, destX: number, destZ: number): { mode: string; legs: TravelLeg[]; reserve: number } {
    if (!Environment.NODE_MEMBERS && !World.gameMap.isFreeToPlay(destX, destZ)) return { mode: 'restricted', legs: [], reserve: 0 };
    const island = onKaramja(p.x, p.z),
        destIsland = onKaramja(destX, destZ);
    const east = p.x >= 2870,
        destEast = destX >= 2870;
    if (island && !destIsland) {
        const leg = destEast ? TRAVEL_LEGS.karamja : TRAVEL_LEGS.brimhaven;
        const reserve = 30 + (homes.has(p) && homes.get(p) !== destEast ? 60 : 0);
        return {
            mode: carriedCoins(p) >= reserve ? 'ship' : 'unaffordable',
            legs: [leg],
            reserve
        };
    }
    if (!island && destIsland) {
        const leg = east ? TRAVEL_LEGS.sarim : TRAVEL_LEGS.ardougne;
        return {
            mode: carriedCoins(p) >= 60 ? 'ship' : 'unaffordable',
            legs: [leg],
            reserve: 60
        };
    }
    if (island || !((p.x >= 2870 && destX < 2830) || (p.x < 2830 && destX >= 2870)) || p.z > 4100) return { mode: 'land', legs: [], reserve: 0 };
    if (!Environment.NODE_MEMBERS) return { mode: 'restricted', legs: [], reserve: 0 };
    if (tunnelAvailable(p))
        return {
            mode: 'tunnel',
            legs: [east ? TRAVEL_LEGS.tunnelWest : TRAVEL_LEGS.tunnelEast],
            reserve: 0
        };
    const condition = travelCondition(p);
    const legs = east ? [TRAVEL_LEGS.sarim, TRAVEL_LEGS.brimhaven] : [TRAVEL_LEGS.ardougne, TRAVEL_LEGS.karamja];
    const distance = (x: number, z: number, a: Point) => Math.max(Math.abs(x - a.x), Math.abs(z - a.z));
    const landTime = (distance(p.x, p.z, point(2853, 3508)) + distance(destX, destZ, point(2853, 3508))) / condition.speed;
    const seaTime = (distance(p.x, p.z, legs[0].from) + distance(destX, destZ, legs[1].to) + 220) / condition.speed + 50;
    // Four native 30-coin fares cover this journey and its return. Spending is
    // also a cost: poorer, healthy characters retain a legitimate walking option.
    const reserve = homes.has(p) && homes.get(p) === destEast ? 60 : 120;
    const seaCost = seaTime + (reserve * 200) / Math.max(reserve, carriedCoins(p));
    const landCost = landTime + condition.damage * (2 - condition.appetite) * 12;
    if (carriedCoins(p) >= reserve && (!condition.safeToWalk || seaCost < landCost)) {
        if ((condition.hp + condition.food * 0.6) * (0.8 + condition.appetite) < condition.damage * 0.08) return { mode: 'unsafe', legs: [], reserve };
        return { mode: 'ship', legs, reserve };
    }
    return {
        mode: condition.safeToWalk ? 'land' : 'unaffordable',
        legs: [],
        reserve
    };
}

type Journey = {
    owner: unknown;
    goal: Point;
    mode: string;
    legs: TravelLeg[];
    index: number;
    clicked: boolean;
    start: number;
    before: number;
    paid: boolean;
    landed: boolean;
    exiting: boolean;
    returnFare: number;
};
const journeys = new WeakMap<Player, Journey>();
const uncertain = new WeakMap<Player, Set<string>>();
export function travelActive(p: Player): boolean {
    return !!journeys.get(p)?.clicked;
}
export function journeyTarget(p: Player, x: number, z: number, level: number): Point | null | false {
    for (const id of uncertain.get(p) ?? []) {
        const leg = Object.values(TRAVEL_LEGS).find(l => l.id === id);
        if (leg && p.level === 0 && Math.max(Math.abs(p.x - leg.to.x), Math.abs(p.z - leg.to.z)) < 12) uncertain.get(p)!.delete(id);
    }
    let j = journeys.get(p);
    const owner = bot(p)?.activeTask;
    if (j?.clicked) return j.legs[j.index].from;
    if (!j || j.owner !== owner || j.goal.level !== level || Math.max(Math.abs(j.goal.x - x), Math.abs(j.goal.z - z)) > 4) {
        const plan = level === 0 && p.level === 0 ? chooseTravel(p, x, z) : { mode: 'land', legs: [], reserve: 0 };
        if (!onKaramja(p.x, p.z) && homes.get(p) === p.x >= 2870) homes.delete(p);
        if (!homes.has(p) && !onKaramja(p.x, p.z) && plan.mode === 'ship') homes.set(p, p.x >= 2870);
        j = {
            owner,
            goal: point(x, z, level),
            mode: plan.mode,
            legs: plan.legs,
            index: 0,
            clicked: false,
            start: 0,
            before: 0,
            paid: false,
            landed: false,
            exiting: false,
            returnFare: plan.reserve - plan.legs.reduce((s, l) => s + l.fare, 0)
        };
        journeys.set(p, j);
        BotLog.event('debug', p.username, 'travel_plan', `${plan.mode} to (${x},${z},${level}), reserve=${plan.reserve}`);
        if (plan.mode === 'unaffordable' || plan.mode === 'restricted' || plan.mode === 'unsafe') {
            bot(p)?.deferCurrentTask(`travel ${plan.mode}: safe journey and return require ${plan.reserve} carried coins`);
            return false;
        }
    }
    if (j.mode === 'unaffordable' || j.mode === 'restricted' || j.mode === 'unsafe') return false;
    return j.index < j.legs.length ? j.legs[j.index].from : null;
}
function nearby(p: Player, x: number, z: number, radius: number) {
    const locs = new Set<import('#/engine/entity/Loc.js').default>();
    const npcs = new Set<import('#/engine/entity/Npc.js').default>();
    for (let dx = -radius; dx <= radius; dx += 8)
        for (let dz = -radius; dz <= radius; dz += 8) {
            const zone = World.gameMap.getZone(x + dx, z + dz, p.level);
            for (const l of zone.getAllLocsSafe()) locs.add(l);
            for (const n of zone.getAllNpcsSafe()) npcs.add(n);
        }
    return { locs: [...locs], npcs: [...npcs] };
}
function clickLoc(p: Player, name: string): boolean {
    const loc = nearby(p, p.x, p.z, 16)
        .locs.filter(l => LocType.get(l.type).debugname === name || (name === 'Cross' && (LocType.get(l.type).op ?? [])[0] === 'Cross'))
        .sort((a, b) => Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(b.x - p.x, b.z - p.z))[0];
    if (!loc) return false;
    const approach = findLocApproach(p, loc);
    if (!approach) return false;
    p.clearPendingAction();
    p.clearWaypoints();
    p.moveSpeed = 1;
    p.setInteraction(Interaction.ENGINE, loc, ServerTriggerType.APLOC1);
    if (approach.path.length) p.queueWaypoints(approach.path);
    return true;
}
export function beginTravelLeg(p: Player): boolean {
    const j = journeys.get(p);
    if (!j || j.index >= j.legs.length) return false;
    const l = j.legs[j.index];
    if (p.level !== 0 || Math.max(Math.abs(p.x - l.from.x), Math.abs(p.z - l.from.z)) > 10) return false;
    if (j.clicked) return true;
    if (l.kind === 'tunnel' && !tunnelAvailable(p)) return false;
    if (uncertain.get(p)?.has(l.id)) {
        bot(p)?.deferCurrentTask('previous fare unresolved; duplicate payment suppressed');
        return false;
    }
    if (l.npc === 'customs_officer' && (p.getInventory(InvType.INV)?.items ?? []).some(i => i && ObjType.get(i.id).debugname === 'karamja_rum')) {
        bot(p)?.deferCurrentTask('customs restriction: rum');
        j.mode = 'restricted';
        return false;
    }
    if (carriedCoins(p) < j.returnFare + j.legs.slice(j.index).reduce((s, l) => s + l.fare, 0)) {
        bot(p)?.deferCurrentTask('travel funds changed');
        return false;
    }
    j.clicked = true;
    j.start = World.currentTick;
    j.before = carriedCoins(p);
    j.paid = false;
    j.landed = false;
    j.exiting = false;
    if (l.loc) {
        if (!clickLoc(p, l.loc)) {
            j.clicked = false;
            return false;
        }
    } else {
        const n = nearby(p, l.from.x, l.from.z, 16)
            .npcs.filter(n => n.isActive && NpcType.get(n.type).debugname === l.npc)
            .sort((a, b) => Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(b.x - p.x, b.z - p.z))[0];
        if (!n) {
            j.clicked = false;
            return false;
        }
        p.clearPendingAction();
        p.clearWaypoints();
        p.moveSpeed = 1;
        p.setInteraction(Interaction.ENGINE, n, ServerTriggerType.APNPC1);
        p.queueWaypoints(trimPathAtCsvBlock(p.level, findPathToEntity(p.level, p.x, p.z, n.x, n.z, p.width, n.width, n.length), p.x, p.z));
    }
    BotLog.event('debug', p.username, 'transport_started', l.id);
    return true;
}
/** Native script owns payment and travel. Never re-click an unresolved paid leg. */
export function tickTravel(p: Player): boolean {
    const j = journeys.get(p);
    if (!j?.clicked) return false;
    const l = j.legs[j.index];
    if (!j.paid && j.before - carriedCoins(p) >= l.fare && l.fare > 0) {
        j.paid = true;
        BotLog.event('debug', p.username, 'transport_fare', `${l.id}: ${l.fare} coins`);
    }
    answerBotDialogue(p, /^(Yes please\.|Can I journey on this ship\?|Search away, I have nothing to hide\.|Ok\.)$/i);
    if (l.kind === 'tunnel' && p.z > 4100) j.landed = true;
    if (p.level === l.to.level && Math.max(Math.abs(p.x - l.to.x), Math.abs(p.z - l.to.z)) < 12) j.landed = true;
    const shoreZ = l.kind === 'tunnel' ? l.to.z - 6400 : l.to.z;
    const exited = j.landed && p.level === 0 && Math.max(Math.abs(p.x - l.to.x), Math.abs(p.z - shoreZ)) < 12;
    if (exited && !p.delayed && !p.activeScript) {
        BotLog.event('debug', p.username, 'transport_arrived', l.id);
        j.index++;
        j.clicked = false;
        bot(p)?.navigation.clearIntermediate();
        return false;
    }
    if (World.currentTick - j.start > 120 && !p.delayed) {
        bot(p)?.deferCurrentTask(`transport unresolved: ${l.id}${j.paid ? ' (payment observed; retry suppressed)' : ''}`);
        // A paid, unconfirmed journey remains quarantined to prevent a second fare.
        if (j.paid) {
            let blocked = uncertain.get(p);
            if (!blocked) {
                blocked = new Set();
                uncertain.set(p, blocked);
            }
            blocked.add(l.id);
        } else {
            if (p.hasInteraction()) p.clearPendingAction();
            p.clearWaypoints();
        }
        j.clicked = false;
        j.mode = 'restricted';
        return true;
    }
    if (j.landed && !p.delayed && !p.activeScript) {
        if (l.kind === 'ship' && p.level === 1) {
            if (!p.hasInteraction()) clickLoc(p, 'Cross');
            return true;
        }
        if (l.kind === 'tunnel' && p.z > 4100) {
            const end = l.id === 'tunnel-west' ? point(2820, 9882) : point(2876, 9878);
            if (Math.max(Math.abs(p.x - end.x), Math.abs(p.z - end.z)) > 2) {
                if (!p.hasWaypoints()) p.queueWaypoints(trimPathAtCsvBlock(0, botWalkPath(0, p.x, p.z, end.x, end.z), p.x, p.z));
                return true;
            }
            if (!j.exiting) {
                j.exiting = clickLoc(p, l.id === 'tunnel-west' ? 'tunnelstairs' : 'tunnelstairs2');
            }
            return true;
        }
    }
    return true;
}
