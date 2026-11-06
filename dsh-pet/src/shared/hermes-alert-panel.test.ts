/** Hermes 提醒面板的纯函数与样式约束。 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { HERMES_ALERT_CSS, hermesTitle } from './hermes-alert-panel.ts';

test('标题已以 Hermes 开头时不重复前缀', () => {
  assert.equal(hermesTitle('Hermes 需要你确认'), 'Hermes 需要你确认');
  assert.equal(hermesTitle('Hermes 定时任务失败'), 'Hermes 定时任务失败');
  assert.equal(hermesTitle('虎妞发来消息'), '虎妞发来消息');
});

test('标题不含 Hermes 时补上来源前缀', () => {
  assert.equal(hermesTitle('任务失败'), 'Hermes · 任务失败');
});

test('提醒样式不覆盖字体族，也不使用假粗体', () => {
  assert.doesNotMatch(HERMES_ALERT_CSS, /font-family/);
  assert.doesNotMatch(HERMES_ALERT_CSS, /font-weight:(?!400)/);
  // 两端气泡基础类都要覆盖到
  assert.match(HERMES_ALERT_CSS, /\.dsh-pet-bubble:has\(>\.dsh-pet-hermes\)/);
  assert.match(HERMES_ALERT_CSS, /\.pet-bubble:has\(>\.dsh-pet-hermes\)/);
});

test('正文用橙色，不再显示「可能已过时」提示', () => {
  assert.match(HERMES_ALERT_CSS, /\.dsh-pet-hermes-msg\{[^}]*color:#2c3f86/);
  assert.doesNotMatch(readFileSync(new URL('./hermes-alert-panel.ts', import.meta.url), 'utf8'), /可能已过时/);
});
