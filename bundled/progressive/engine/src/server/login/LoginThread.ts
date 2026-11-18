import fs from 'fs';
import { withPlayerSaveLock, writePlayerSave, checkSaveOperation, type SaveOperationState } from '#/server/login/PlayerSave.js';
import { parentPort } from 'worker_threads';

import { LoginClient } from '#/server/login/LoginClient.js';
import Environment from '#/util/Environment.js';

import { type GenericLoginThreadResponse } from './index.d.js';
import { trackLoginAttempts, trackLoginTime } from './LoginMetrics.js';

const client = new LoginClient(Environment.NODE_ID);
const localSaves = new Map<string, SaveOperationState>();
const localSessions = new Map<string, string>();
const localCandidates = new Map<string, Set<string>>();
const pendingAdmissions = new Map<string, string>();

async function confirmAdmission(username: string, sessionId: string): Promise<void> {
    if (pendingAdmissions.get(username) !== sessionId) return;
    if (!(await client.playerAdmit(username, sessionId))) throw new Error('Save session admission failed');
    pendingAdmissions.delete(username);
}

if (!parentPort) throw new Error('This file must be run as a worker thread.');

parentPort.on('message', async msg => {
    try {
        if (!parentPort) throw new Error('This file must be run as a worker thread.');
        if (msg.username) {
            await withPlayerSaveLock(`${Environment.NODE_PROFILE}/${msg.username}`, () => handleRequests(parentPort!, msg));
        } else {
            await handleRequests(parentPort, msg);
        }
    } catch (err) {
        console.error(err);
        if (msg.type === 'player_logout') {
            parentPort!.postMessage({ type: 'player_logout', username: msg.username, saveId: msg.saveId, success: false });
        }
    }
});

client.onMessage((opcode, data) => {
    parentPort!.postMessage({ opcode, data });
});

type ParentPort = {
    postMessage: (msg: GenericLoginThreadResponse) => void;
};

async function handleRequests(parentPort: ParentPort, msg: any) {
    const { type } = msg;

    switch (type) {
        case 'world_startup': {
            if (Environment.LOGIN_SERVER) {
                await client.worldStartup();
            }
            break;
        }
        case 'player_login': {
            const { socket, remoteAddress, username, password, uid, lowMemory, reconnecting, hasSave } = msg;

            if (Environment.LOGIN_SERVER) {
                trackLoginAttempts.inc();
                const stopTimer = trackLoginTime.startTimer();
                const response = await client.playerLogin(username, password, uid, socket, remoteAddress, reconnecting, hasSave);

                if (!Environment.NODE_PRODUCTION) {
                    response.staffmodlevel = 4; // dev (destructive commands)
                }

                parentPort.postMessage({
                    type: 'player_login',
                    socket,
                    username,
                    lowMemory,
                    reconnecting,
                    ...response
                });
                stopTimer();
            } else {
                let candidates = localCandidates.get(username);
                if (!candidates) { candidates = new Set(); localCandidates.set(username, candidates); }
                candidates.add(socket);
                let staffmodlevel = 0;

                if (!Environment.NODE_PRODUCTION) {
                    staffmodlevel = 4; // dev (destructive commands)
                }

                const profile = Environment.NODE_PROFILE;
                if (!fs.existsSync(`data/players/${profile}`)) {
                    fs.mkdirSync(`data/players/${profile}`, { recursive: true });
                }

                if (!fs.existsSync(`data/players/${profile}/${username}.sav`)) {
                    parentPort.postMessage({
                        type: 'player_login',
                        socket,
                        username,
                        lowMemory,
                        reconnecting,
                        reply: 4,
                        staffmodlevel,
                        save: null,
                        account_id: 1,
                        members: Environment.NODE_MEMBERS
                    });
                } else {
                    parentPort.postMessage({
                        type: 'player_login',
                        socket,
                        username,
                        lowMemory,
                        reconnecting,
                        reply: 0,
                        staffmodlevel,
                        save: fs.readFileSync(`data/players/${profile}/${username}.sav`),
                        account_id: 1,
                        members: Environment.NODE_MEMBERS
                    });
                }
            }
            break;
        }
        case 'player_admit': {
            const { username, sessionId } = msg;
            if (Environment.LOGIN_SERVER) {
                pendingAdmissions.set(username, sessionId);
                await confirmAdmission(username, sessionId);
            } else {
                if (!localCandidates.get(username)?.delete(sessionId)) throw new Error('Unknown login candidate');
                localSessions.set(username, sessionId);
            }
            break;
        }
        case 'player_logout': {
            const { username, save, saveId, sessionId } = msg;

            if (Environment.LOGIN_SERVER) {
                await confirmAdmission(username, sessionId);
                const success = await client.playerLogout(username, save, msg);

                parentPort.postMessage({
                    type: 'player_logout',
                    username,
                    saveId,
                    success
                });
            } else {
                const profile = Environment.NODE_PROFILE;
                if (!fs.existsSync(`data/players/${profile}`)) {
                    fs.mkdirSync(`data/players/${profile}`, { recursive: true });
                }

                if (!checkSaveOperation(msg, localSaves.get(username))) {
                    if (localSessions.has(username) && localSessions.get(username) !== sessionId) throw new Error('Stale save session');
                    const operation = { saveId, saveSequence: msg.saveSequence, sessionId, completed: false };
                    localSaves.set(username, operation);
                    await writePlayerSave(`data/players/${profile}/${username}.sav`, save);
                    operation.completed = true;
                }

                parentPort.postMessage({
                    type: 'player_logout',
                    username,
                    saveId,
                    success: true
                });
            }
            break;
        }
        case 'player_autosave': {
            const { username, save, saveId, sessionId } = msg;

            if (Environment.LOGIN_SERVER) {
                await confirmAdmission(username, sessionId);
                await client.playerAutosave(username, save, msg);
            } else {
                const profile = Environment.NODE_PROFILE;
                if (!fs.existsSync(`data/players/${profile}`)) {
                    fs.mkdirSync(`data/players/${profile}`, { recursive: true });
                }

                if (!checkSaveOperation(msg, localSaves.get(username))) {
                    if (localSessions.has(username) && localSessions.get(username) !== sessionId) throw new Error('Stale save session');
                    const operation = { saveId, saveSequence: msg.saveSequence, sessionId, completed: false };
                    localSaves.set(username, operation);
                    await writePlayerSave(`data/players/${profile}/${username}.sav`, save);
                    operation.completed = true;
                }
            }
            break;
        }
        case 'player_force_logout': {
            localCandidates.get(msg.username)?.delete(msg.sessionId);
            if (Environment.LOGIN_SERVER) {
                const { username } = msg;
                await client.playerForceLogout(username, msg.sessionId, msg.candidateOnly);
            }
            break;
        }
        case 'player_ban': {
            if (Environment.LOGIN_SERVER) {
                // todo: wait for confirmation? resend?
                const { staff, username, until } = msg;
                await client.playerBan(staff, username, until);
            }
            break;
        }
        case 'player_mute': {
            if (Environment.LOGIN_SERVER) {
                // todo: wait for confirmation? resend?
                const { staff, username, until } = msg;
                await client.playerMute(staff, username, until);
            }
            break;
        }
        case 'world_heartbeat': {
            break;
        }
        default:
            console.error('Unknown message type: ' + msg.type);
            break;
    }
}
