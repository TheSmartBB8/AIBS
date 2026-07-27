// registry.js — the tool roster.
//
// TOOL is the single source of truth. Anything added here must resolve to a real
// implementation with a cooldown; tests/tools.test.mjs walks this enum so a tool that
// gets an entry but never an implementation fails the build rather than the player.

import { sledgehammer } from './melee.js';
import { spraycan } from './spray.js';
import { extinguisher } from './extinguisher.js';
import { blowtorch } from './blowtorch.js';
import { pistol, shotgun, rifle, minigun } from './firearms.js';
import { pipebomb, bomb, nitro, rocket } from './explosives.js';
import { plank, winch } from './construct.js';

export const TOOL = {
  SLEDGEHAMMER: 'sledgehammer',
  SPRAYCAN:     'spraycan',
  EXTINGUISHER: 'extinguisher',
  BLOWTORCH:    'blowtorch',
  SHOTGUN:      'shotgun',
  PISTOL:       'pistol',
  RIFLE:        'rifle',
  PIPEBOMB:     'pipebomb',
  BOMB:         'bomb',
  NITRO:        'nitro',
  ROCKET:       'rocket',
  MINIGUN:      'minigun',
  PLANK:        'plank',
  WINCH:        'winch',
};

/** Hotbar order (slot 1..14). */
export const TOOL_ORDER = [
  TOOL.SLEDGEHAMMER, TOOL.SPRAYCAN, TOOL.EXTINGUISHER, TOOL.BLOWTORCH,
  TOOL.SHOTGUN, TOOL.PISTOL, TOOL.RIFLE,
  TOOL.PIPEBOMB, TOOL.BOMB, TOOL.NITRO, TOOL.ROCKET, TOOL.MINIGUN,
  TOOL.PLANK, TOOL.WINCH,
];

export const TOOLS = {
  [TOOL.SLEDGEHAMMER]: sledgehammer,
  [TOOL.SPRAYCAN]:     spraycan,
  [TOOL.EXTINGUISHER]: extinguisher,
  [TOOL.BLOWTORCH]:    blowtorch,
  [TOOL.SHOTGUN]:      shotgun,
  [TOOL.PISTOL]:       pistol,
  [TOOL.RIFLE]:        rifle,
  [TOOL.PIPEBOMB]:     pipebomb,
  [TOOL.BOMB]:         bomb,
  [TOOL.NITRO]:        nitro,
  [TOOL.ROCKET]:       rocket,
  [TOOL.MINIGUN]:      minigun,
  [TOOL.PLANK]:        plank,
  [TOOL.WINCH]:        winch,
};

export function getTool(id) {
  const t = TOOLS[id];
  if (!t) throw new Error(`unknown tool: ${id}`);
  return t;
}

/** Effective cooldown for a tool right now (the minigun's varies with spin-up). */
export function cooldownOf(tool, state) {
  return (typeof tool.cooldownFor === 'function' && state) ? tool.cooldownFor(state) : tool.cooldown;
}
