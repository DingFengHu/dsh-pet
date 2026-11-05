/** Hermes 提醒快照与链接边界的最小契约。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readHermesAlerts, safeHermesUrl, selectHermesAlert } from './hermes-alerts.ts';
import { resolveLeafPath } from './state.ts';
import { decideBubbleSlot } from '../client/pet/card/bubble-slots.ts';

test('链接白名单拒绝执行协议、凭据、畸形编码与多段 Hermes 路径', () => {
  for (const url of [
    'javascript:alert(1)',
    'file:///secret',
    'dsh://open',
    'https://user:pass@example.test',
    'hermes://open/a/b',
    'hermes://open/id?cmd=x',
    'hermes://open/%GG',
    'hermes://open/%00',
    'hermes://open/..',
    'hermes://open/%2e%2e',
    'hermes://other/id',
    'https://example.test\\evil',
    '',
    null,
  ]) {
    assert.equal(safeHermesUrl(url), undefined, String(url));
  }
  assert.equal(safeHermesUrl('hermes://open/a%2Fb%20c'), 'hermes://open/a%2Fb%20c');
  assert.equal(
    safeHermesUrl('https://example.test/#/profiles/local/sessions/a'),
    'https://example.test/#/profiles/local/sessions/a',
  );
});

test('快照过滤非法条目和重复 ID，非法 URL 只禁用查看，stale 保留旧提醒', () => {
  const snapshot = readHermesAlerts({
    counter: 1,
    data: {
      petId: 'blue',
      stale: true,
      alerts: [
        { id: 'one', title: '<script>', message: '确认提醒', url: 'javascript:evil()' },
        { id: 'one', title: 'duplicate', message: '' },
        { id: '', title: 'invalid', message: '' },
        { id: 'two', title: 'second', message: '', url: 'hermes://open/id' },
      ],
    },
  });
  assert.equal(snapshot?.alerts.length, 2);
  assert.equal(snapshot?.stale, true);
  assert.equal(selectHermesAlert(snapshot, 'blue', false)?.id, 'one');
  assert.equal(selectHermesAlert(snapshot, 'blue', false)?.url, undefined);
  assert.equal(selectHermesAlert(snapshot, 'other', false), null);
  assert.equal(selectHermesAlert(snapshot, 'blue', true), null);
  for (const data of [
    null,
    {},
    { petId: 'blue', stale: false, alerts: 'invalid' },
    { petId: '', stale: false, alerts: [] },
  ]) {
    assert.equal(readHermesAlerts({ counter: 1, data }), null);
  }
  assert.deepEqual(resolveLeafPath('sections.hermesAlerts'), { where: 'section', name: 'hermesAlerts' });
});

test('Hermes 槽让位于用户待办，压过工作与说话，不修改它们的输入', () => {
  const input = {
    todoOn: false,
    hermesOn: true,
    workTerminal: true,
    workOn: true,
    workText: '完成',
    workStatusEnabled: true,
    whisperOn: true,
    whisperText: '在',
  };
  assert.equal(decideBubbleSlot(input), 'hermes');
  assert.equal(decideBubbleSlot({ ...input, todoOn: true }), 'todo');
  assert.equal(decideBubbleSlot({ ...input, hermesOn: false }), 'work-terminal');
  assert.equal(input.workOn, true);
  assert.equal(input.whisperOn, true);
});
