import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BotMovementMonitor } from '#/engine/bot/BotMovementMonitor.js';
import { BotRouteRetry } from '#/engine/bot/BotRouteRetry.js';
import { BotLogger } from '#/engine/bot/BotLog.js';
import { BotTickMetrics } from '#/engine/bot/BotTickMetrics.js';

test('stationary skilling, banking, combat and social waits never oscillate', () => {
    for (const walking of [false, true]) {
        const monitor = new BotMovementMonitor();
        for (let tick = 0; tick < 600; tick++) {
            monitor.update(3085, 3555, walking, false);
            assert.equal(monitor.isOscillating(), false, `walking=${walking}, tick=${tick}`);
            assert.equal(monitor.isStuck(), walking && tick >= 9);
        }
    }
});

test('real period-2 and period-3 walking cycles still trigger recovery', () => {
    for (const cycle of [[1, 2], [1, 2, 3]]) {
        const monitor = new BotMovementMonitor();
        for (let i = 0; i < cycle.length * 3; i++) monitor.update(3200 + cycle[i % cycle.length], 3200, true, true);
        assert.equal(monitor.isOscillating(), true);
        monitor.resetOscillation();
        assert.equal(monitor.isOscillating(), false);
    }
});

test('brief movement followed by five stationary ticks is not a movement cycle', () => {
    const monitor = new BotMovementMonitor();
    monitor.update(3200, 3200, true, true);
    for (let i = 0; i < 5; i++) monitor.update(3201, 3200, true, false);
    assert.equal(monitor.isOscillating(), false);
});

test('idle gaps, script pauses, floor changes and reset break history', () => {
    const monitor = new BotMovementMonitor();
    for (let i = 0; i < 9; i++) monitor.update(3200, 3200, true, false);
    monitor.update(3200, 3200, false, false);
    assert.equal(monitor.getStuckTicks(), 0);
    monitor.update(3200, 3200, true, false, 1);
    assert.equal(monitor.getStuckTicks(), 1);
    for (let i = 0; i < 6; i++) monitor.update(3200 + i % 2, 3200, true, true, i % 2);
    assert.equal(monitor.isOscillating(), false);
    monitor.reset();
    assert.equal(monitor.getStuckTicks(), 0);
});

test('failed edges expire and the cache stays bounded under changing failures', () => {
    const monitor = new BotMovementMonitor();
    for (let i = 0; i < 100; i++) monitor.addFailedEdge(0, i, 1, i + 1, 1, 0);
    assert.equal((monitor as any).failedEdges.size, 64);
    assert.equal(monitor.isEdgeFailed(0, 99, 1, 100, 1, 99), true);
    assert.equal(monitor.isEdgeFailed(0, 99, 1, 100, 1, 100), false);
});

test('failed routes back off, exhaust a budget and reset on observed progress', () => {
    const route = new BotRouteRetry();
    assert.equal(route.request(1, 1, 0, 20, 1, 0), true);
    assert.equal(route.fail(0), false);
    assert.equal(route.canAttempt(3), false);
    assert.equal(route.canAttempt(4), true);
    route.request(1, 1, 0, 20, 1, 0); // queuing the same request is not progress
    route.fail(4);
    route.fail(12);
    assert.equal(route.fail(28), true);
    route.request(5, 1, 0, 20, 1, 0);
    assert.equal(route.failures, 0);
    assert.equal(route.canAttempt(29), true);
    route.fail(29);
    assert.equal(route.request(5, 1, 0, 20, 1, 1), true);
    assert.equal(route.failures, 1); // floor changes retarget, but do not forgive failures
    assert.equal(route.canAttempt(30), false);
});

test('logging filters detail, retains failure counts, rate limits each bot and reports repeats', () => {
    const lines: string[] = [];
    const logger = new BotLogger('info', 10, line => lines.push(line));
    logger.event('debug', 'a', 'detail', 'XP gained');
    logger.event('warn', 'a', 'navigation_stuck', 'blocked');
    logger.tick = 1;
    logger.event('warn', 'a', 'navigation_stuck', 'blocked');
    logger.event('warn', 'b', 'navigation_stuck', 'blocked');
    assert.equal(lines.length, 2);
    assert.equal(logger.counts.navigation_stuck, 3);
    assert.equal(logger.filtered, 1);
    assert.equal(logger.suppressed, 1);
    logger.tick = 10;
    logger.event('warn', 'a', 'navigation_stuck', 'blocked');
    assert.match(lines[2], /1 repeats suppressed/);
    assert.equal(logger.counts.navigation_stuck, 4);
});

test('long detours without destination progress cannot keep resetting the route budget', () => {
    const route = new BotRouteRetry();
    route.request(10, 10, 0, 50, 50, 0, 0);
    for (let tick = 1; tick <= 100; tick++) route.request(10 - tick % 5, 10, 0, 50, 50, 0, tick);
    assert.equal(route.isStalled(100), true);
    route.fail(100);
    assert.equal(route.isStalled(101), false);
    route.request(20, 20, 0, 50, 50, 0, 150);
    assert.equal(route.isStalled(200), false);
    assert.equal(route.failures, 0);
});

test('legitimate activity pauses the route watchdog without erasing failure history', () => {
    const route = new BotRouteRetry();
    route.request(10, 10, 0, 50, 50, 0, 0);
    route.fail(0);
    for (let tick = 1; tick <= 300; tick++) route.observe(10, 10, 0, false, tick);
    route.request(10, 10, 0, 50, 50, 0, 301);
    assert.equal(route.isStalled(301), false);
    assert.equal(route.failures, 1);
    for (let tick = 302; tick <= 401; tick++) route.observe(10, 10, 0, true, tick);
    assert.equal(route.isStalled(401), true);
});

test('log configuration supports off, unlimited diagnostics and bounded rate-limit state', () => {
    const lines: string[] = [];
    const off = new BotLogger('off', 10, line => lines.push(line));
    off.event('error', 'a', 'failure', 'failed');
    assert.equal(off.counts.failure, 1);
    assert.equal(lines.length, 0);
    const debug = new BotLogger('debug', 0, line => lines.push(line));
    for (let i = 0; i < 5000; i++) debug.event('warn', String(i), 'failure', 'failed');
    assert.equal(lines.length, 5000);
    assert.equal((debug as any).recent.size, 0);
    const limited = new BotLogger('warn', 10, () => {});
    for (let i = 0; i < 5000; i++) limited.event('warn', String(i), 'failure', 'failed');
    assert.equal((limited as any).recent.size, 4096);
});

test('population summary interval is independent of diagnostic repeat limiting', () => {
    const lines: string[] = [];
    const logger = new BotLogger('info', 1000, line => lines.push(line));
    logger.event('info', 'population', 'summary', '100 active', false);
    logger.tick = 10;
    logger.event('info', 'population', 'summary', '100 active', false);
    assert.equal(lines.length, 2);
    assert.equal(logger.suppressed, 0);
});

test('tick metrics retain percentiles, true maximum and 600ms overruns with bounded memory', () => {
    const metrics = new BotTickMetrics();
    metrics.record(601);
    for (let i = 0; i < 999; i++) metrics.record(2);
    assert.deepEqual(metrics.snapshot(), { count: 1000, meanMs: 2.599, p95Ms: 2, maxMs: 601, over600ms: 1 });
    assert.equal((metrics as any).samples.length, 600);
    metrics.reset();
    assert.equal(metrics.snapshot().count, 0);
});

test('randomized nearby destinations retain the retry budget and exponential backoff', () => {
    const route = new BotRouteRetry();
    route.request(0, 0, 0, 50, 50, 0, 0);
    const attempts: number[] = [];
    for (let tick = 0; tick <= 28; tick++) {
        assert.equal(route.request(0, 0, 0, 50 + tick % 3 - 1, 50 + (tick * 2) % 3 - 1, 0, tick), false);
        if (route.canAttempt(tick)) {
            attempts.push(tick);
            assert.equal(route.fail(tick), attempts.length === 4);
        }
    }
    assert.deepEqual(attempts, [0, 4, 12, 28]);
    assert.equal(route.failures, 4);
});

test('large randomized retargets, selecting the current tile and floor changes cannot replenish retries', () => {
    const route = new BotRouteRetry();
    route.request(10, 10, 0, 50, 50, 0, 0);
    route.fail(0);
    for (let tick = 1; tick <= 100; tick++) {
        const target = tick % 2 ? 10 : 100 + tick;
        route.request(10, 10, 0, target, target, tick % 3, tick);
        assert.equal(route.failures, 1);
    }
    assert.equal(route.isStalled(100), true);
});

test('jitter is compared to a stable anchor so cumulative target motion still retargets', () => {
    const route = new BotRouteRetry();
    route.request(0, 0, 0, 50, 50, 0);
    for (let dx = 1; dx <= 4; dx++) assert.equal(route.request(0, 0, 0, 50 + dx, 50, 0), false);
    assert.equal(route.request(0, 0, 0, 55, 50, 0), true);
    assert.equal(route.request(0, 0, 0, 55, 50, 1), true);
});

test('actual travel and arrival restore retries while a target approaching a stationary bot does not', () => {
    const route = new BotRouteRetry();
    route.request(0, 0, 0, 20, 0, 0);
    route.fail(0);
    route.request(0, 0, 0, 10, 0, 0, 1);
    assert.equal(route.failures, 1);
    assert.equal(route.canAttempt(1), false);
    route.observe(3, 0, 0, true, 4);
    assert.equal(route.failures, 0);
    assert.equal(route.canAttempt(4), true);
    route.fail(4);
    route.request(3, 0, 0, 5, 0, 0, 5);
    assert.equal(route.failures, 1);
    route.observe(5, 0, 0, true, 6); // arrival after a short legitimate retarget
    assert.equal(route.failures, 0);
});

test('a short successful local trip credits arrival once without allowing stationary budget resets', () => {
    const route = new BotRouteRetry();
    route.request(0, 0, 0, 20, 0, 0, 0);
    route.observe(20, 0, 0, true, 1);
    route.fail(1);
    assert.equal(route.request(20, 0, 0, 21, 0, 0, 2), false);
    assert.equal(route.failures, 1);
    route.observe(21, 0, 0, true, 3);
    assert.equal(route.failures, 0);
    route.fail(3);
    route.observe(21, 0, 0, true, 4);
    route.request(21, 0, 0, 21, 0, 0, 4);
    assert.equal(route.failures, 1);
});
