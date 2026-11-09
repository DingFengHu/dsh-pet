/** Hermes 提醒面板的纯函数与样式约束。 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { HERMES_ALERT_CSS, hermesTitle } from './hermes-alert-panel.ts';

test('标题统一以「老大，」开头，已带来源时不重复 Hermes 前缀', () => {
  assert.equal(hermesTitle('Hermes 需要你确认'), '老大，Hermes 需要你确认');
  assert.equal(hermesTitle('Hermes 定时任务失败', 2), '老大，Hermes 定时任务失败 (2)');
  assert.equal(hermesTitle('Claude 等你批准 · dsh-pet'), '老大，Claude 等你批准 · dsh-pet');
  assert.equal(hermesTitle('Windows 计划任务失败 · memwatch'), '老大，Windows 计划任务失败 · memwatch');
  assert.equal(hermesTitle('DSH · 需要确认'), '老大，DSH · 需要确认');
  assert.equal(hermesTitle('任务失败'), '老大，Hermes · 任务失败');
});

test('虎妞转发的消息标题为「老大，虎妞说：」', () => {
  assert.equal(hermesTitle('虎妞'), '老大，虎妞说：');
  assert.equal(hermesTitle(' 虎妞 ', 3), '老大，虎妞说（3 条）：');
});

test('只有正文改用系统正常字体，其余继承气泡字体；不使用假粗体', () => {
  const families = HERMES_ALERT_CSS.match(/[^{}]*\{[^}]*font-family[^}]*\}/g) ?? [];
  assert.equal(families.length, 1);
  assert.match(
    families[0]!,
    /^\.dsh-pet-hermes-msg\{[^}]*font-family:"Microsoft YaHei UI","Microsoft YaHei","PingFang SC","Segoe UI",sans-serif/,
  );
  assert.doesNotMatch(HERMES_ALERT_CSS, /font-weight:(?!400)/);
  // 两端气泡基础类都要覆盖到
  assert.match(HERMES_ALERT_CSS, /\.dsh-pet-bubble:has\(>\.dsh-pet-hermes\)/);
  assert.match(HERMES_ALERT_CSS, /\.pet-bubble:has\(>\.dsh-pet-hermes\)/);
});

test('正文用大肥鱼蓝，不再显示「可能已过时」提示', () => {
  assert.match(HERMES_ALERT_CSS, /\.dsh-pet-hermes-msg\{[^}]*color:#2c3f86/);
  assert.doesNotMatch(readFileSync(new URL('./hermes-alert-panel.ts', import.meta.url), 'utf8'), /可能已过时/);
});

test('点「知道了」先停掉这一条的朗读；桌面朗读带上提醒 id', () => {
  const panel = readFileSync(new URL('./hermes-alert-panel.ts', import.meta.url), 'utf8');
  assert.match(panel, /const id = view\.alert\.id;[\s\S]{0,120}stopAlertSpeech\(id\);[\s\S]{0,40}pending = true;/);
  const bubble = readFileSync(new URL('../../runtime/electron-helper/sprite/bubble.js', import.meta.url), 'utf8');
  assert.match(bubble, /S\.speakAlert\([^;]*alert\.id\)/);
});
