import { randomUUID } from 'node:crypto';
import type { SaveOperation } from '#/server/login/PlayerSave.js';
import InternalClient from '#/server/InternalClient.js';
import Environment from '#/util/Environment.js';

export class LoginClient extends InternalClient {
    private nodeId = 0;
    private readonly worldId = randomUUID();
    private readonly worldStartedAt = Date.now();
    private announcedConnection: unknown = null;

    constructor(nodeId: number) {
        super(Environment.LOGIN_HOST, Environment.LOGIN_PORT);

        this.nodeId = nodeId;
    }

    public async worldStartup() {
        await this.connect();

        if (!this.ws || !this.wsr || !this.wsr.checkIfWsLive()) {
            return;
        }

        if (this.announcedConnection === this.ws) return;
        this.announcedConnection = this.ws;
        this.ws.send(
            JSON.stringify({
                type: 'world_startup',
                worldId: this.worldId,
                worldStartedAt: this.worldStartedAt,
                nodeId: this.nodeId,
                nodeTime: Date.now(),
                profile: Environment.NODE_PROFILE
            })
        );
    }

    public async playerLogin(username: string, password: string, uid: number, socket: string, remoteAddress: string, reconnecting: boolean, hasSave: boolean) {
        await this.worldStartup();

        if (!this.ws || !this.wsr || !this.wsr.checkIfWsLive()) {
            return { reply: -1, account_id: -1, save: null, muted_until: null, members: false };
        }

        const reply = await this.wsr.fetchSync({
            type: 'player_login',
            nodeId: this.nodeId,
            worldId: this.worldId,
            nodeTime: Date.now(),
            nodeMembers: Environment.NODE_MEMBERS,
            profile: Environment.NODE_PROFILE,

            socket, remoteAddress, uid,
            username, password,
            reconnecting, hasSave
        });

        if (reply.error) {
            this.announcedConnection = null;
            return { reply: -1, account_id: -1, save: null, muted_until: null, members: false };
        }

        if (reply.result.response === 7) this.announcedConnection = null;
        const { response, account_id, staffmodlevel, save, muted_until, members, messageCount, remaining } = reply.result;
        return {
            reply: response,
            account_id,
            staffmodlevel,
            save: save ? Buffer.from(save, 'base64') : null,
            muted_until,
            members,
            messageCount,
            remaining
        };
    }

    // Authentication is provisional until World has actually admitted the socket.
    public async playerAdmit(username: string, sessionId: string): Promise<boolean> {
        await this.worldStartup();
        if (!this.ws || !this.wsr || !this.wsr.checkIfWsLive()) return false;
        const reply = await this.wsr.fetchSync({
            type: 'player_admit', nodeId: this.nodeId, worldId: this.worldId,
            profile: Environment.NODE_PROFILE, username, sessionId
        });
        return !reply.error && reply.result.response === 0 && reply.result.sessionId === sessionId;
    }

    // returns true if the login server acknowledged the logout
    public async playerLogout(username: string, save: Uint8Array, operation: SaveOperation) {
        await this.worldStartup();

        if (!this.ws || !this.wsr || !this.wsr.checkIfWsLive()) {
            return false;
        }

        const reply = await this.wsr.fetchSync({
            type: 'player_logout',
            saveId: operation.saveId,
            saveSequence: operation.saveSequence,
            sessionId: operation.sessionId,
            nodeId: this.nodeId,
            worldId: this.worldId,
            nodeTime: Date.now(),
            profile: Environment.NODE_PROFILE,
            username,
            save: Buffer.from(save).toString('base64')
        });

        if (reply.error || reply.result.response !== 0) {
            this.announcedConnection = null; // permit retry after a failed startup reset
            return false;
        }

        return reply.result.saveId === operation.saveId;
    }

    // we don't care about acknowledgement, send the save and continue on
    public async playerAutosave(username: string, save: Uint8Array, operation: SaveOperation) {
        await this.worldStartup();

        if (!this.ws || !this.wsr || !this.wsr.checkIfWsLive()) {
            return;
        }

        this.ws.send(
            JSON.stringify({
                type: 'player_autosave',
                saveId: operation.saveId,
                saveSequence: operation.saveSequence,
                sessionId: operation.sessionId,
                nodeId: this.nodeId,
                worldId: this.worldId,
                nodeTime: Date.now(),
                profile: Environment.NODE_PROFILE,
                username,
                save: Buffer.from(save).toString('base64')
            })
        );
    }

    // in case the player is stuck logged-in
    public async playerForceLogout(username: string, sessionId: string, candidateOnly = false) {
        await this.worldStartup();

        if (!this.ws || !this.wsr || !this.wsr.checkIfWsLive()) {
            return;
        }

        this.ws.send(
            JSON.stringify({
                type: 'player_force_logout',
                sessionId,
                candidateOnly,
                nodeId: this.nodeId,
                worldId: this.worldId,
                nodeTime: Date.now(),
                profile: Environment.NODE_PROFILE,
                username
            })
        );
    }

    public async playerBan(staff: string, username: string, until: Date) {
        await this.connect();

        if (!this.ws || !this.wsr || !this.wsr.checkIfWsLive()) {
            return;
        }

        this.ws.send(
            JSON.stringify({
                type: 'player_ban',
                nodeId: this.nodeId,
                nodeTime: Date.now(),
                staff,
                username,
                until
            })
        );
    }

    public async playerMute(staff: string, username: string, until: Date) {
        await this.connect();

        if (!this.ws || !this.wsr || !this.wsr.checkIfWsLive()) {
            return;
        }

        this.ws.send(
            JSON.stringify({
                type: 'player_mute',
                nodeId: this.nodeId,
                nodeTime: Date.now(),
                staff,
                username,
                until
            })
        );
    }
}
