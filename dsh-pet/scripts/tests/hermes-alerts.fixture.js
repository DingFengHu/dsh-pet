import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { jsx } from 'react/jsx-runtime';
import * as shared from '../../src/shared/index.ts';
import { createPetMulti } from '../../src/client/pet/multi.ts';
import { createBubbleSlots } from '../../src/client/pet/card/bubble-slots.ts';
import { makeHermesAlertBubble } from '../../src/client/hermes-alert-bubble.ts';

const rt = { h: jsx, useEffect, useRef, useState };
const HermesBubble = makeHermesAlertBubble(rt);
const useSlots = createBubbleSlots(rt, {
  hermesBubble: HermesBubble,
  todoBubble: () => jsx('div', { children: '用户待办' }),
  whisperBubble: ({ text }) => jsx('div', { children: text }),
});
function Card(props) {
  const [locked, setLocked] = useState(false);
  const slots = useSlots({
    workStatusEnabled: true,
    workTerminal: true,
    hermesAlert: shared.selectHermesAlert(props.hermesAlerts, props.cfg.id, locked || props.lock?.locked === true),
    hermesCount: props.hermesAlerts?.alerts.length ?? 0,
    hermesStale: props.hermesAlerts?.stale ?? false,
    onFocusSession: () => window.wrongFocus++,
  });
  window.slots = slots;
  window.lockAlerts = setLocked;
  return jsx('div', {
    onPointerDown: () => window.petDrags++,
    onClick: () => window.wrongFocus++,
    children: slots.node(),
  });
}
window.S = shared;
window.wrongFocus = 0;
window.petDrags = 0;
window.opened = [];
window.open = (...args) => window.opened.push(args);
const Multi = createPetMulti(rt, Card);
createRoot(document.getElementById('root')).render(jsx(Multi, {}));
