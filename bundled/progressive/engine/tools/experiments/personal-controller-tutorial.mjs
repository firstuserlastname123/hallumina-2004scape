/** Test setup only: complete the native tutorial without skipping or editing state. */
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
export async function finishTutorial(page, results, ids, readStage) {
    const view = () => page.evaluate(() => globalThis.__pr8Test.snapshot());
    const command = action => page.evaluate(a => globalThis.__pr8Test.command(a), action);
    const deadline = Date.now() + 20 * 60_000;
    let previous = -1, changedAt = Date.now(), lastCommandAt = 0, ratTarget = null;
    let notReadySince = 0;
    results.tutorial = [];
    while (Date.now() < deadline) {
        const s = await view();
        if (!s?.ready) {
            notReadySince ||= Date.now();
            if (Date.now() - notReadySince > 30_000) throw new Error('Tutorial character disconnected or scene failed to load');
            await delay(600); continue;
        }
        notReadySince = 0;
        // The tutorial varp is server-only in r254. The test world's read-only
        // observer supplies assertions/setup sequencing; the product never reads it.
        const stage = readStage();
        if (stage === undefined) { await delay(600); continue; }
        results.setupLatest = { stage, position: s.position, main: s.main, chat: s.chat, messages: s.messages, inventory: s.inventory, components: s.components.filter(c => c.buttonType > 0 || c.text) };
        if (stage !== previous) { console.log('Native tutorial stage', stage, s.position); results.tutorial.push({ stage, at: Date.now(), position: s.position }); previous = stage; changedAt = Date.now(); }
        if (stage === 1000) { assert.ok(results.tutorial.some(s => s.stage === 660) || results.characterFixture?.tutorialStages.includes(660), 'Must cast successfully before leaving'); return s; }
        if (Date.now() - changedAt > ([430, 440, 460].includes(stage) ? 180_000 : 90_000)) throw new Error(`Tutorial stalled at ${stage}: ${JSON.stringify(s)}`);
        const button = s.components.find(c => c.clientCode === 326) ||
            (stage === 1 ? s.components.find(c => /No, thank you/.test(c.text)) : null) ||
            ([500, 670].includes(stage) ? s.components.find(c => c.buttonType === 1 && /^Yes\.$/.test(c.text.trim())) : null) ||
            s.components.find(c => c.buttonType === 6);
        if (button) { await command({ kind: 'button', id: button.id }); await delay(800); continue; }
        if (s.moving || s.animation !== -1 || Date.now() - lastCommandAt < 3000) { await delay(600); continue; }
        lastCommandAt = Date.now();
        const nearest = list => list.sort((a, b) => Math.max(Math.abs(a.x - s.position.x), Math.abs(a.z - s.position.z)) - Math.max(Math.abs(b.x - s.position.x), Math.abs(b.z - s.position.z)))[0];
        const npc = (name, option = 'Talk-to') => {
            const n = nearest(s.npcs.filter(n => n.name === name));
            return n ? command({ kind: 'npc', index: n.index, op: n.options.indexOf(option), approach: true }).then(() => true) : false;
        };
        const object = (name, option) => {
            const o = nearest(s.objects.filter(o => typeof name === 'number' ? o.id === name : o.name === name));
            return o ? command({ kind: 'object', ...o, op: option ? o.options.indexOf(option) : 0 }) : false;
        };
        const item = name => s.inventory.find(i => typeof name === 'number' ? i.id === name : i.name === name);
        const equip = name => { const i = item(name); return i ? command({ kind: 'item', slot: i.slot, op: i.options.findIndex(o => /wield|wear/i.test(o ?? '')) }) : false; };
        const useObject = (name, target) => {
            const i = item(name), o = nearest(s.objects.filter(o => typeof target === 'number' ? o.id === target : o.name === target));
            return i && o ? command({ kind: 'use-object', ...o, slot: i.slot }) : false;
        };
        const useItems = (a, b) => item(a) && item(b) ? command({ kind: 'use-items', first: item(a).slot, second: item(b).slot }) : false;
        const walk = (x, z) => command({ kind: 'walk', x, z });
        const tab = tab => command({ kind: 'tab', tab });
        const attackRat = () => {
            const rats = s.npcs.filter(n => n.name === 'Giant rat');
            const rat = rats.find(n => n.index === ratTarget) ?? nearest(rats);
            if (rat) { ratTarget = rat.index; return command({ kind: 'npc', index: rat.index, op: rat.options.indexOf('Attack') }); }
        };
        switch (stage) {
            case 0: break; // Appearance dialog is handled above.
            case 1: await npc('RuneScape Guide'); break;
            case 4: await object(ids.newbie_door1); break;
            case 10: if (s.position.z > 3100) await walk(3104, 3098); else await npc('Survival Expert'); break;
            case 20: await tab(3); break;
            case 30: await object('Tree', 'Chop down'); break;
            case 40: await useItems('Tinderbox', 'Logs'); break;
            case 50: await tab(1); break;
            case 60: await npc('Survival Expert'); break;
            case 70: await npc('Fishing spot', 'Net'); break;
            case 80: case 90:
                if (!item('Raw shrimps')) await npc('Fishing spot', 'Net');
                else if (!s.objects.some(o => o.name === 'Fire')) {
                    if (item('Logs')) await useItems('Tinderbox', 'Logs'); else await object('Tree', 'Chop down');
                } else await useObject('Raw shrimps', 'Fire');
                break;
            case 120: await object(ids.newbiegateclosedl2); break;
            case 130: await object(ids.newbie_door2); break;
            case 140: await npc('Master Chef'); break;
            case 150: await useItems('Pot of flour', 'Bucket of water'); break;
            case 160: await useObject('Bread dough', 'Range'); break;
            case 170: await tab(13); break;
            case 180: await object(ids.newbie_door3); break;
            case 190: await tab(12); break;
            case 195: await command({ kind: 'button', id: 153 }); break; // Native player_controls:run.
            case 200: if (s.position.z < 3110) await walk(3072, 3110); else await object(ids.newbie_door4); break;
            case 220: await npc('Quest Guide'); break;
            case 230: await tab(2); break;
            case 240: await npc('Quest Guide'); break;
            case 250: await object(ids.newbieladdertop1); break;
            case 260: await npc('Mining Instructor'); break;
            case 270: case 275: await object(ids.newbiecopperrock, 'Prospect'); break;
            case 274: await object(ids.newbietinrock, 'Prospect'); break;
            case 279: case 280: await npc('Mining Instructor'); break;
            case 290: case 295: await object(ids.newbiecopperrock, 'Mine'); break;
            case 294: await object(ids.newbietinrock, 'Mine'); break;
            case 320: await useObject('Copper ore', ids.newbiefurnace); break;
            case 330: await npc('Mining Instructor'); break;
            case 340:
                if (s.main !== -1) await command({ kind: 'smith', id: 1205, slot: 0, component: 1119 });
                else await useObject('Bronze bar', 'Anvil');
                break;
            case 350: await object(ids.newbiedoor4l); break;
            case 360: await npc('Combat Instructor'); break;
            case 370: await tab(4); break;
            case 380: await equip('Bronze dagger'); break;
            case 390: await npc('Combat Instructor'); break;
            case 400:
                if (item('Bronze sword')) await equip('Bronze sword'); else if (item('Wooden shield')) await equip('Wooden shield');
                break;
            case 410: await tab(0); break;
            case 420: await object(ids.newbiedoor5_l); break;
            case 430: case 440: await attackRat(); break;
            case 450: {
                const guide = s.npcs.find(n => n.name === 'Combat Instructor');
                const reachable = guide && await page.evaluate(n => !!globalThis.__gameClient.personalController.game.approach(n, 1, 1), guide);
                if (!reachable) await object(ids.newbiedoor5_l); else await npc('Combat Instructor');
                break;
            }
            case 460:
                if (item('Shortbow')) await equip('Shortbow');
                else if (item('Bronze arrow')) await equip('Bronze arrow');
                else await attackRat();
                break;
            case 470: await object(ids.newbieladder2); break;
            case 500: await object(ids.newbiebankbooth); break;
            case 510: if (s.main !== -1) await command({ kind: 'close' }); else await object(ids.newbie_door6); break;
            case 520: await npc('Financial Advisor'); break;
            case 530: await object(ids.newbie_door7); break;
            case 540: {
                const brother = s.npcs.find(n => n.name === 'Brother Brace');
                const reachable = brother && await page.evaluate(n => !!globalThis.__gameClient.personalController.game.approach(n, 1, 1), brother);
                if (!reachable) await object(1519, 'Open'); // Native east chapel entrance, not the tutorial-gated exit.
                else await npc('Brother Brace');
                break;
            }
            case 550: await tab(5); break;
            case 560: await npc('Brother Brace'); break;
            case 570: await tab(8); break;
            case 580: await tab(9); break;
            case 590: await npc('Brother Brace'); break;
            case 600: await object(ids.newbie_door8); break;
            case 610: if (!(await npc('Magic Instructor'))) await walk(3141, 3088); break;
            case 620: await tab(6); break;
            case 630: await npc('Magic Instructor'); break;
            case 640: case 650: {
                const chicken = nearest(s.npcs.filter(n => n.name === 'Chicken'));
                if (chicken) await command({ kind: 'cast', component: 1152, index: chicken.index }); break;
            }
            case 660: case 670: await npc('Magic Instructor'); break;
            default: throw new Error(`Unexpected tutorial stage: ${stage}`);
        }
        await delay(600);
    }
    throw new Error('Tutorial setup exceeded 20 minutes');
}
