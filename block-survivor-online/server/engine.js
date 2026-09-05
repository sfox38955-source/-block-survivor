// =====================================================================
// Block Survivor - Online Co-op — Authoritative server engine
// Adapted from the original single-player engine. Runs ONLY on the
// server. All game-affecting decisions (movement, damage, drops,
// upgrades) happen here; clients only send input and render snapshots.
// =====================================================================
'use strict';

const WORLD_W = 1000;
const WORLD_H = 750;
const BORDER_MARGIN = 25;
const PLAYER_MOVE_SPEED = 145;
const BASE_FIRE_RATE = 0.65;
const DEFAULT_RANGE = 270;
const DEFAULT_VIEW_DIST = 300;

const VOTE_TIMEOUT_SECONDS = 20; // overridden by room config if provided

// ---------------------------------------------------------------
// Upgrade pool (identical effects to the original single-player game)
// `apply(p)` mutates a player object; used both for solo-style apply
// and, in team mode, applied once per surviving player after a vote.
// ---------------------------------------------------------------
const upgradePool = [
  { id: 'power', name: 'Attack Power', rarity: 'basic', rarityLabel: 'Basic', unlockDoor: 1, weight: 100, description: 'Significant increase in attack power.', effect: '+5% damage', apply: p => { p.damage *= 1.05; } },
  { id: 'damage10', name: 'Precise Strike', rarity: 'basic', rarityLabel: 'Basic', unlockDoor: 1, weight: 90, description: 'Small boost to weapon damage.', effect: '+3 damage', apply: p => { p.damage += 3; } },
  { id: 'magnet', name: 'XP Magnet', rarity: 'basic', rarityLabel: 'Basic', unlockDoor: 1, weight: 70, description: 'Attract XP shards from further away.', effect: '+5% pickup range', apply: p => { p.magnet *= 1.05; } },
  { id: 'regen', name: 'Regeneration', rarity: 'basic', rarityLabel: 'Basic', unlockDoor: 1, weight: 80, description: 'Slow health recovery over time.', effect: '+0.5 HP/s', apply: p => { p.regen += 0.5; } },
  { id: 'xpboost', name: 'Bonus XP', rarity: 'basic', rarityLabel: 'Basic', unlockDoor: 1, weight: 75, description: 'Increased experience gain.', effect: '+2% XP', apply: p => { p.xpBonus += 0.02; } },
  { id: 'warrior', name: 'Warrior', rarity: 'basic', rarityLabel: 'Basic', unlockDoor: 1, weight: 85, description: 'Stronger attack boost.', effect: '+3% damage', apply: p => { p.damage *= 1.03; } },
  { id: 'heart', name: 'Tough Heart', rarity: 'basic', rarityLabel: 'Basic', unlockDoor: 1, weight: 90, description: 'Increases maximum health.', effect: '+10 HP', apply: p => { p.maxHp += 10; p.hp = Math.min(p.maxHp, p.hp + 10); } },
  { id: 'armor_basic', name: 'Steel Armor', rarity: 'basic', rarityLabel: 'Basic', unlockDoor: 1, weight: 70, description: 'Reduces incoming damage.', effect: '+1 armor', apply: p => { p.armor += 1; } },
  { id: 'critbasic', name: 'Focus', rarity: 'basic', rarityLabel: 'Basic', unlockDoor: 1, weight: 60, description: 'Increases critical hit chance.', effect: '+1% crit', apply: p => { p.critChance = Math.min(0.75, p.critChance + 0.01); } },
  { id: 'rangeUp', name: 'Extended Range', rarity: 'basic', rarityLabel: 'Basic', unlockDoor: 1, weight: 65, description: 'Widen your attack range.', effect: '+10% range', apply: p => { p.range *= 1.10; } },
  { id: 'viewRange', name: 'Improved Vision', rarity: 'basic', rarityLabel: 'Basic', unlockDoor: 1, weight: 65, description: 'Increase view distance.', effect: '+5% view distance', apply: p => { p.viewDist *= 1.05; } },
  { id: 'orbit', name: 'Guardian Orbit', rarity: 'rare', rarityLabel: 'Rare', unlockDoor: 3, weight: 30, description: 'Adds an orbiting shard.', effect: '+1 orbit', apply: p => { p.orbit += 1; } },
  { id: 'critical', name: 'Advanced Critical', rarity: 'rare', rarityLabel: 'Rare', unlockDoor: 2, weight: 40, description: 'Big increase in critical chance.', effect: '+3% crit', apply: p => { p.critChance = Math.min(0.82, p.critChance + 0.03); } },
  { id: 'critpower', name: 'Fury Grip', rarity: 'rare', rarityLabel: 'Rare', unlockDoor: 2, weight: 35, description: 'Critical hits deal more damage.', effect: 'crit multiplier +0.3', apply: p => { p.critMultiplier += 0.3; } },
  { id: 'lifesteal', name: 'Lifesteal', rarity: 'rare', rarityLabel: 'Rare', unlockDoor: 2, weight: 45, description: 'Heal a portion of damage dealt.', effect: '+0.5% lifesteal', apply: p => { p.lifesteal += 0.005; } },
  { id: 'pierceRare', name: 'Piercing', rarity: 'rare', rarityLabel: 'Rare', unlockDoor: 4, weight: 20, description: 'Projectiles pass through extra enemies.', effect: '+1 pierce (reduced damage)', apply: p => { p.pierce += 1; } },
  { id: 'splashRare', name: 'Controlled Explosion', rarity: 'rare', rarityLabel: 'Rare', unlockDoor: 3, weight: 25, description: 'Small tactical explosion.', effect: '+12% splash damage', apply: p => { p.splash += 0.12; } },
  { id: 'dodgeRare', name: 'Dodge', rarity: 'rare', rarityLabel: 'Rare', unlockDoor: 2, weight: 35, description: 'Chance to evade enemy attacks.', effect: '+2.5% dodge', apply: p => { p.dodge = Math.min(0.60, p.dodge + 0.025); } },
  { id: 'orbitPower', name: 'Orbit Power', rarity: 'rare', rarityLabel: 'Rare', unlockDoor: 3, weight: 25, description: 'Increase orbit shard damage.', effect: '+3 orbit damage', apply: p => { p.orbitDamage += 3; } },
  { id: 'xpRare', name: 'Treasure Hunter', rarity: 'rare', rarityLabel: 'Rare', unlockDoor: 2, weight: 40, description: 'Big XP boost.', effect: '+4% XP', apply: p => { p.xpBonus += 0.04; } },
  { id: 'viewRare', name: 'Far Horizon', rarity: 'rare', rarityLabel: 'Rare', unlockDoor: 2, weight: 30, description: 'Increase view distance significantly.', effect: '+10% view distance', apply: p => { p.viewDist *= 1.10; } },
  { id: 'iceTouch', name: 'Ice Touch', rarity: 'rare', rarityLabel: 'Rare', unlockDoor: 2, weight: 35, description: 'Attacks slow enemies by 15%.', effect: 'slow 15% for 2s', apply: p => { p.slowChance = 1; p.slowDuration = 2; p.slowPercent = 0.15; } },
  { id: 'spark', name: 'Electric Spark', rarity: 'rare', rarityLabel: 'Rare', unlockDoor: 2, weight: 30, description: 'Chance to chain hit to nearby enemy.', effect: '10% chain', apply: p => { p.chainChance = Math.min(0.60, p.chainChance + 0.10); } },
  { id: 'giant', name: 'Giant Heart', rarity: 'epic', rarityLabel: 'Epic', unlockDoor: 4, weight: 25, description: 'Big max health boost.', effect: '+30 HP', apply: p => { p.maxHp += 30; p.hp = Math.min(p.maxHp, p.hp + 30); } },
  { id: 'gravel', name: 'Shard Rain', rarity: 'epic', rarityLabel: 'Epic', unlockDoor: 4, weight: 20, description: 'Extra projectile per attack.', effect: '+1 projectile', apply: p => { p.shots += 1; p.weaponName = 'Shard Rain'; } },
  { id: 'pierceEpic', name: 'Devastating Pierce', rarity: 'epic', rarityLabel: 'Epic', unlockDoor: 6, weight: 12, description: 'Projectile pierces several enemies.', effect: '+2 pierce (reduced damage)', apply: p => { p.pierce += 2; } },
  { id: 'splashEpic', name: 'Shockwave', rarity: 'epic', rarityLabel: 'Epic', unlockDoor: 4, weight: 18, description: 'Wider and stronger wave, but limited against bosses.', effect: '+20% splash damage', apply: p => { p.splash += 0.20; } },
  { id: 'tankBuster', name: 'Crush', rarity: 'epic', rarityLabel: 'Epic', unlockDoor: 4, weight: 22, description: 'Strong attack power increase.', effect: '+7% damage', apply: p => { p.damage *= 1.07; } },
  { id: 'ironWill', name: 'Iron Will', rarity: 'epic', rarityLabel: 'Epic', unlockDoor: 4, weight: 20, description: 'Armor plus health.', effect: '+2 armor & +20 HP', apply: p => { p.armor += 2; p.maxHp += 20; p.hp = Math.min(p.maxHp, p.hp + 20); } },
  { id: 'viewEpic', name: 'Omnisight', rarity: 'epic', rarityLabel: 'Epic', unlockDoor: 4, weight: 18, description: 'Massive view distance increase.', effect: '+15% view distance', apply: p => { p.viewDist *= 1.15; } },
  { id: 'poison', name: 'Potent Poison', rarity: 'epic', rarityLabel: 'Epic', unlockDoor: 5, weight: 20, description: 'Attacks deal damage over time.', effect: '+2.5 poison/s for 3.5s', apply: p => { p.poisonDamage += 2.5; p.poisonDuration = Math.max(p.poisonDuration, 3.5); } },
  { id: 'deepFreeze', name: 'Deep Freeze', rarity: 'epic', rarityLabel: 'Epic', unlockDoor: 4, weight: 18, description: 'Chance to freeze enemy completely.', effect: 'slow 30% for 2s + 5% freeze', apply: p => { p.slowChance = 1; p.slowDuration = Math.max(p.slowDuration, 2); p.slowPercent = Math.max(p.slowPercent, 0.30); p.freezeChance = Math.min(0.55, p.freezeChance + 0.05); } },
  { id: 'double', name: 'Royal Projectiles', rarity: 'legendary', rarityLabel: 'Legendary', unlockDoor: 7, weight: 8, description: 'Extra projectiles per attack.', effect: '+2 projectiles', apply: p => { p.shots += 2; p.weaponName = 'Royal Bow'; } },
  { id: 'legend_power', name: 'Legendary Power', rarity: 'legendary', rarityLabel: 'Legendary', unlockDoor: 7, weight: 10, description: 'Big damage and health boost.', effect: '+12% damage & +30 HP', apply: p => { p.damage *= 1.12; p.maxHp += 30; p.hp = Math.min(p.maxHp, p.hp + 30); } },
  { id: 'bloodMoon', name: 'Blood Moon', rarity: 'legendary', rarityLabel: 'Legendary', unlockDoor: 7, weight: 9, description: 'Critical and lifesteal improvements.', effect: '+2% crit & +1% lifesteal', apply: p => { p.critChance = Math.min(0.9, p.critChance + 0.02); p.lifesteal += 0.01; } },
  { id: 'orbitalArmy', name: 'Orbital Army', rarity: 'legendary', rarityLabel: 'Legendary', unlockDoor: 8, weight: 5, description: 'Three extra orbits.', effect: '+3 orbits', apply: p => { p.orbit += 3; } },
  { id: 'viewLegend', name: 'Eye of Wisdom', rarity: 'legendary', rarityLabel: 'Legendary', unlockDoor: 7, weight: 8, description: 'Near complete view of the field.', effect: '+20% view distance', apply: p => { p.viewDist *= 1.20; } },
  { id: 'bleed', name: 'Savage Bleed', rarity: 'legendary', rarityLabel: 'Legendary', unlockDoor: 7, weight: 8, description: 'Critical hits cause bleeding.', effect: '15% of critical damage as bleed', apply: p => { p.bleedMultiplier = Math.min(0.75, p.bleedMultiplier + 0.15); } },
  { id: 'galaxy', name: 'Shard Galaxy', rarity: 'mythic', rarityLabel: 'Mythic', unlockDoor: 12, weight: 2, description: 'Four extra orbits.', effect: '+4 orbits', apply: p => { p.orbit += 4; } },
  { id: 'apocalypse', name: 'Apocalypse', rarity: 'mythic', rarityLabel: 'Mythic', unlockDoor: 12, weight: 3, description: 'Damage, armor and health boost.', effect: '+15% damage +3 armor +40 HP', apply: p => { p.damage *= 1.15; p.armor += 3; p.maxHp += 40; p.hp = Math.min(p.maxHp, p.hp + 40); } },
  { id: 'voidHunter', name: 'Void Hunter', rarity: 'mythic', rarityLabel: 'Mythic', unlockDoor: 12, weight: 3, description: 'Damage and critical increase.', effect: '+10% damage & +3% crit', apply: p => { p.damage *= 1.10; p.critChance = Math.min(0.95, p.critChance + 0.03); } },
  { id: 'viewMythic', name: 'Infinite Horizon', rarity: 'mythic', rarityLabel: 'Mythic', unlockDoor: 12, weight: 2, description: 'See everything.', effect: '+25% view distance', apply: p => { p.viewDist *= 1.25; } },
  { id: 'lightning', name: 'Lightning Storm', rarity: 'mythic', rarityLabel: 'Mythic', unlockDoor: 12, weight: 2, description: 'Periodic lightning strikes the biggest enemy.', effect: '50 damage every 5s', apply: p => { p.lightningDamage += 50; p.lightningCooldown = 5; } },
];

function pickUpgrades(currentDoor) {
  const available = upgradePool.filter(c => c.unlockDoor <= currentDoor);
  const selected = [], pool = [...available];
  while (selected.length < 3 && pool.length) {
    const total = pool.reduce((sum, card) => sum + (card.weight || 50), 0);
    if (total === 0) break;
    let r = Math.random() * total;
    let chosen = pool[pool.length - 1];
    for (const card of pool) { r -= (card.weight || 50); if (r <= 0) { chosen = card; break; } }
    selected.push(chosen);
    pool.splice(pool.indexOf(chosen), 1);
  }
  return selected.map(c => ({ id: c.id, name: c.name, description: c.description, effect: c.effect, rarity: c.rarity, rarityLabel: c.rarityLabel }));
}

function applyUpgradeById(player, id) {
  const card = upgradePool.find(c => c.id === id);
  if (card) card.apply(player);
}

// ---------------------------------------------------------------
// Math helpers
// ---------------------------------------------------------------
const distance = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);
const randomBetween = (min, max) => min + Math.random() * (max - min);
function clampToBorder(obj, margin = BORDER_MARGIN) {
  obj.x = Math.max(margin, Math.min(WORLD_W - margin, obj.x));
  obj.y = Math.max(margin, Math.min(WORLD_H - margin, obj.y));
}
function pointToSegmentDistance(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)));
  return distance(px, py, ax + dx * t, ay + dy * t);
}

// ---------------------------------------------------------------
// Player factory
// ---------------------------------------------------------------
function createPlayer(id, name) {
  return {
    id, name,
    x: WORLD_W / 2 + randomBetween(-40, 40), y: WORLD_H / 2 + randomBetween(-40, 40),
    hp: 100, maxHp: 100,
    speed: PLAYER_MOVE_SPEED, fireRate: BASE_FIRE_RATE, damage: 13, shots: 1,
    critChance: 0.08, critMultiplier: 1.8, armor: 0, weaponName: 'Wooden Bow',
    magnet: 75, orbit: 0, orbitDamage: 18, orbitClock: 0, shotClock: 0.15, invulnerable: 0,
    regen: 0, lifesteal: 0, pierce: 0, splash: 0, dodge: 0,
    xpBonus: 1, facing: 1, walkCycle: 0, attackKick: 0, aimAngle: 0,
    range: DEFAULT_RANGE, viewDist: DEFAULT_VIEW_DIST, scarfAngle: 0,
    slowChance: 0, slowDuration: 0, slowPercent: 0,
    chainChance: 0, poisonDamage: 0, poisonDuration: 0,
    freezeChance: 0, bleedMultiplier: 0, lightningDamage: 0, lightningCooldown: 0, lightningTimer: 0,
    input: { h: 0, v: 0, aimX: null, aimY: null, aiming: false },
    alive: true, kills: 0, connected: true,
  };
}

// ---------------------------------------------------------------
// Engine factory (one per room)
// ---------------------------------------------------------------
function createEngine() {
  return {
    players: {}, // id -> player
    enemies: [], projectiles: [], enemyProjectiles: [], shards: [], chests: [],
    events: [], // transient events this tick, for client-side cosmetic FX / toasts
    door: 1, doorKills: 0, totalKills: 0, doorGoal: 0, doorStarted: false, doorCleared: false,
    spawnClock: 0, elapsed: 0, id: 1,
    teamXp: 0, teamLevel: 1, teamNextXp: 35,
    awaitingUpgrade: false,
    bossAttacks: {}, bossWarnings: [],
    id_: 1,
  };
}

function alivePlayers(engine) {
  return Object.values(engine.players).filter(p => p.connected && p.alive);
}
function difficultyScale(engine) {
  const n = Math.max(1, alivePlayers(engine).length || Object.keys(engine.players).length || 1);
  // team of 1 == identical to solo baseline; scales up gently per extra player
  return 1 + (n - 1) * 0.55;
}

function nearestPlayer(engine, x, y) {
  let best = null, bestD = Infinity;
  for (const p of alivePlayers(engine)) {
    const d = distance(x, y, p.x, p.y);
    if (d < bestD) { bestD = d; best = p; }
  }
  return best;
}

// Spread-aggro target picker: prefers the nearest player but leans away
// from players who already have many enemies on them, so the team gets
// hit as a group instead of the whole horde dog-piling one person.
function pickSpreadTarget(engine, enemy) {
  const players = alivePlayers(engine);
  if (players.length === 0) return null;
  if (players.length === 1) return players[0];
  const aggroCount = {};
  for (const p of players) aggroCount[p.id] = 0;
  for (const e of engine.enemies) {
    if (e !== enemy && e.targetId && aggroCount[e.targetId] !== undefined) aggroCount[e.targetId]++;
  }
  let best = null, bestScore = -Infinity;
  for (const p of players) {
    const d = distance(enemy.x, enemy.y, p.x, p.y);
    // closer is better, more-already-targeted is worse
    const score = -d - aggroCount[p.id] * 90;
    if (score > bestScore) { bestScore = score; best = p; }
  }
  return best;
}

function xpValueForLevel(level, enemy) {
  const base = enemy.boss ? 10 : (enemy.size > 20 ? 6 : 4);
  return Math.max(1, Math.round(base * (1 + (level - 1) * 0.22)));
}

function addEvent(engine, type, data) { engine.events.push({ type, ...data }); }

function damagePlayer(engine, player, amount) {
  if (!player || player.invulnerable > 0 || player.hp <= 0) return false;
  if (Math.random() < player.dodge) { addEvent(engine, 'dodge', { x: player.x, y: player.y }); return false; }
  player.hp = Math.max(0, player.hp - Math.max(1, amount - player.armor));
  player.invulnerable = 0.38;
  addEvent(engine, 'hurt', { x: player.x, y: player.y, playerId: player.id });
  if (player.hp <= 0) {
    player.alive = false;
    addEvent(engine, 'playerDown', { playerId: player.id, name: player.name });
  }
  return true;
}

function registerEnemyKill(engine, enemy) {
  if (enemy.dead) return false;
  enemy.dead = true; engine.doorKills++; engine.totalKills++;
  const drops = enemy.boss ? 7 : (enemy.type === 'brute' ? 3 : (enemy.size > 20 ? 2 : 1));
  for (let d = 0; d < drops; d++) {
    engine.shards.push({ id: engine.id++, x: enemy.x + randomBetween(-10, 10), y: enemy.y + randomBetween(-10, 10), value: xpValueForLevel(engine.teamLevel, enemy) });
  }
  addEvent(engine, 'kill', { x: enemy.x, y: enemy.y, boss: enemy.boss, color: enemy.color });
  return true;
}

function damageEnemy(engine, enemy, amount, sourceX, sourceY, isCrit, opts, sourcePlayer) {
  opts = opts || {};
  if (!enemy || enemy.dead || enemy.hp <= 0) return true;
  const rawAmount = Math.max(0, Number(amount) || 0);
  const safeAmount = enemy.shieldTimer > 0 ? rawAmount * (1 - (enemy.shieldStrength || 0.5)) : rawAmount;
  enemy.hp -= safeAmount;
  enemy.flash = 0.1; enemy.squish = 1;
  if (!opts.skipKnockback && sourceX !== undefined && sourceY !== undefined) {
    const a = Math.atan2(enemy.y - sourceY, enemy.x - sourceX);
    const k = enemy.boss ? 12 : enemy.type === 'tank' ? 20 : 55;
    enemy.knockX = (enemy.knockX || 0) + Math.cos(a) * k;
    enemy.knockY = (enemy.knockY || 0) + Math.sin(a) * k;
  }
  if (opts.showNumber !== false && safeAmount > 0) {
    addEvent(engine, 'damage', { x: enemy.x, y: enemy.y - enemy.size - 4, amount: safeAmount, crit: !!isCrit });
  }
  const p = sourcePlayer;
  if (!opts.skipEffects && p) {
    if (p.slowChance > 0 && p.slowDuration > 0 && Math.random() < p.slowChance) {
      enemy.slowTimer = Math.max(enemy.slowTimer || 0, p.slowDuration);
      enemy.slowPercent = Math.max(enemy.slowPercent || 0, p.slowPercent || 0);
    }
    if (p.freezeChance > 0 && Math.random() < p.freezeChance) {
      enemy.frozen = true; enemy.slowTimer = 0;
      enemy.freezeUntil = engine.elapsed + 1.0;
    }
    if (p.poisonDamage > 0 && p.poisonDuration > 0) {
      enemy.poisonTimer = Math.max(enemy.poisonTimer || 0, p.poisonDuration);
      enemy.poisonDamage = p.poisonDamage;
    }
    if (p.bleedMultiplier > 0 && isCrit) {
      const bleedDmg = safeAmount * p.bleedMultiplier;
      enemy.bleedTimer = Math.max(enemy.bleedTimer || 0, 3);
      enemy.bleedDamage = Math.max(enemy.bleedDamage || 0, bleedDmg / 3);
    }
    if (p.chainChance > 0 && !opts.noChain && Math.random() < p.chainChance) {
      let nearest = null, nearestDist = 120;
      for (const other of engine.enemies) {
        if (other === enemy || other.dead) continue;
        const d = distance(enemy.x, enemy.y, other.x, other.y);
        if (d < nearestDist) { nearestDist = d; nearest = other; }
      }
      if (nearest) damageEnemy(engine, nearest, Math.max(1, p.damage * 0.45), enemy.x, enemy.y, false, { noChain: true }, p);
    }
  }
  if (enemy.hp <= 0) { registerEnemyKill(engine, enemy); return true; }
  return false;
}

function spawnEnemy(engine, boss, typeOverride, countsTowardGoal) {
  if (countsTowardGoal === undefined) countsTowardGoal = true;
  const margin = BORDER_MARGIN + 10;
  const edge = Math.floor(Math.random() * 4);
  let x, y;
  if (edge === 0) { x = randomBetween(margin, WORLD_W - margin); y = margin; }
  else if (edge === 1) { x = WORLD_W - margin; y = randomBetween(margin, WORLD_H - margin); }
  else if (edge === 2) { x = randomBetween(margin, WORLD_W - margin); y = WORLD_H - margin; }
  else { x = margin; y = randomBetween(margin, WORLD_H - margin); }

  const dScale = difficultyScale(engine);
  const scale = (1 + (engine.door - 1) * 0.06) * dScale;
  const roll = Math.random();
  const type = typeOverride || (boss ? 'boss' : engine.door >= 6 && roll < 0.12 ? 'splitter' : engine.door >= 5 && roll < 0.25 ? 'assassin' : engine.door >= 4 && roll < 0.39 ? 'brute' : engine.door >= 3 && roll < 0.53 ? 'tank' : engine.door >= 2 && roll < 0.69 ? 'shooter' : engine.door >= 2 && roll < 0.82 ? 'charger' : 'grunt');
  let bossType = 'monarch';
  if (boss) bossType = engine.door % 20 === 0 ? 'butcher' : 'monarch';
  const baseHp = (25 + engine.door * 3) * scale;

  let hp, size, speed, damage;
  if (boss) {
    const bossScale = (1 + (engine.door - 1) * 0.12) * dScale;
    hp = (400 + 50 * engine.door) * bossScale;
    size = 31; speed = 30 + engine.door * 0.4; damage = (18 + engine.door * 0.5) * (1 + (dScale - 1) * 0.4);
  } else {
    hp = type === 'brute' ? baseHp * 2.8 : type === 'tank' ? baseHp * 2.2 : type === 'splitter' ? baseHp * 1.55 : type === 'assassin' ? baseHp * 0.62 : type === 'charger' ? baseHp * 0.8 : type === 'shooter' ? baseHp * 0.7 : baseHp;
    size = type === 'brute' ? 22 : type === 'tank' ? 19 : type === 'splitter' ? 17 : type === 'assassin' ? 11 : type === 'charger' ? 13 : type === 'shooter' ? 12 : Math.floor(randomBetween(10, 15));
    speed = type === 'brute' ? 19 : type === 'tank' ? 24 : type === 'splitter' ? 28 : type === 'assassin' ? 68 : type === 'charger' ? 55 : type === 'shooter' ? 30 : 32;
    const dmgScale = 1 + (dScale - 1) * 0.35;
    damage = (type === 'brute' ? 13 + engine.door * 0.55 : type === 'tank' ? 11 + engine.door * 0.5 : type === 'splitter' ? 9 + engine.door * 0.4 : type === 'assassin' ? 7 + engine.door * 0.5 : type === 'charger' ? 8 + engine.door * 0.4 : type === 'shooter' ? 5 + engine.door * 0.3 : 6 + engine.door * 0.4) * dmgScale;
  }

  const enemyObj = {
    id: engine.id++, x, y, hp, maxHp: hp, speed, size, damage,
    color: boss ? (bossType === 'monarch' ? '#d43b7a' : '#c0392b') : type === 'brute' ? '#8b5a45' : type === 'tank' ? '#8f76a9' : type === 'splitter' ? '#6d9b69' : type === 'assassin' ? '#8e5aa8' : type === 'charger' ? '#d38b53' : type === 'shooter' ? '#5f9b9d' : (Math.random() > 0.5 ? '#bc6a69' : '#6878a9'),
    boss: !!boss, type, hitClock: type === 'shooter' ? 1.1 : boss ? 1.7 : 0,
    abilityClock: type === 'splitter' ? 4.5 : type === 'assassin' ? 2.8 : type === 'grunt' ? 5.5 : type === 'minion' ? 5.5 : type === 'tank' ? 4.8 : type === 'brute' ? 4.2 : 0,
    phase: 0, flash: 0, facing: Math.random() * Math.PI * 2, knockX: 0, knockY: 0, squish: 0, bobPhase: Math.random() * Math.PI * 2,
    bossType: boss ? bossType : null,
    slowTimer: 0, slowPercent: 0, poisonTimer: 0, poisonDamage: 0, frozen: false, bleedTimer: 0, bleedDamage: 0,
    enrageTimer: 0, enrageMultiplier: 1, shieldTimer: 0, shieldStrength: 0,
    skillFlash: 0, skillTimer: 0, skillResolved: false,
    targetId: null, retargetClock: 0,
  };
  clampToBorder(enemyObj);
  engine.enemies.push(enemyObj);
  if (engine.doorStarted && countsTowardGoal) engine.doorGoal++;
  if (boss) {
    engine.bossAttacks[enemyObj.id] = { cooldown: 1.5, phase: 0, warning: false, warningTimer: 0, attackActive: false, chargeDir: 0, aoeList: [], ringCount: 0, laserAngle: 0, spawnCount: 0, type: bossType, isFinished: true, kind: null, timer: 0, hitPlayer: false, zones: [] };
  }
  return enemyObj;
}

function startDoor(engine) {
  engine.doorStarted = true; engine.doorCleared = false; engine.doorKills = 0; engine.doorGoal = 0; engine.chests = [];
  const boss = engine.door % 10 === 0;
  const teamN = Math.max(1, alivePlayers(engine).length || 1);
  if (boss) spawnEnemy(engine, true);
  const supporting = (boss ? 3 : Math.min(5, 2 + Math.floor(engine.door / 4))) + Math.floor((teamN - 1) * 1.5);
  for (let i = 0; i < supporting; i++) spawnEnemy(engine);
  if (engine.door % 3 === 0) {
    for (let c = 0; c < teamN; c++) {
      engine.chests.push({ id: engine.id++, x: randomBetween(80, WORLD_W - 80), y: randomBetween(80, WORLD_H - 80), opened: false });
    }
  }
  engine.spawnClock = Math.max(0.7, (2.5 - engine.door * 0.01) / (1 + (teamN - 1) * 0.35));
}

// ---------------- Boss attacks ----------------
function beginBossAttack(engine, enemy, kind, warningTime, message) {
  const attack = engine.bossAttacks[enemy.id];
  if (!enemy.boss || !attack || !attack.isFinished) return false;
  attack.isFinished = false; attack.warning = true; attack.attackActive = false;
  attack.warningTimer = warningTime; attack.timer = warningTime; attack.kind = kind;
  attack.phase = 0; attack.hitPlayer = false; attack.zones = [];
  if (message) addEvent(engine, 'announce', { message });
  return true;
}
function finishBossAttack(attack, min, max) {
  attack.warning = false; attack.attackActive = false; attack.isFinished = true;
  attack.phase = 0; attack.kind = null; attack.zones = [];
  attack.cooldown = min + Math.random() * (max - min);
}
function bossChargeAttack(engine, enemy) {
  const target = pickSpreadTarget(engine, enemy) || nearestPlayer(engine, enemy.x, enemy.y);
  if (!target) return;
  if (beginBossAttack(engine, enemy, 'charge', 1.0, '⚠️ Boss charges!')) {
    const attack = engine.bossAttacks[enemy.id];
    attack.chargeDir = Math.atan2(target.y - enemy.y, target.x - enemy.x);
    engine.bossWarnings.push({ sourceId: enemy.id, x: enemy.x, y: enemy.y, angle: attack.chargeDir, life: 1.4, type: 'charge', length: 280, progress: 0 });
  }
}
function bossAOEAttack(engine, enemy) {
  const target = pickSpreadTarget(engine, enemy) || nearestPlayer(engine, enemy.x, enemy.y);
  if (!target) return;
  if (beginBossAttack(engine, enemy, 'aoe', 1.0, '⚠️ Boss prepares explosion!')) {
    const attack = engine.bossAttacks[enemy.id];
    const zones = [];
    for (let i = 0; i < 3; i++) {
      const a = Math.random() * Math.PI * 2, d = 55 + Math.random() * 105;
      const zx = Math.max(BORDER_MARGIN, Math.min(WORLD_W - BORDER_MARGIN, target.x + Math.cos(a) * d));
      const zy = Math.max(BORDER_MARGIN, Math.min(WORLD_H - BORDER_MARGIN, target.y + Math.sin(a) * d));
      zones.push({ x: zx, y: zy, remaining: 1.2, detonated: false });
      engine.bossWarnings.push({ sourceId: enemy.id, x: zx, y: zy, radius: 10, maxRadius: 65, life: 1.4, type: 'aoe_zone', progress: 0 });
    }
    attack.zones = zones; attack.timer = 1.2; attack.phase = 1.2;
  }
}
function bossRingAttack(engine, enemy) {
  beginBossAttack(engine, enemy, 'ring', 0.8, '🌀 Boss unleashes rings!');
  engine.bossWarnings.push({ sourceId: enemy.id, x: enemy.x, y: enemy.y, life: 1.2, type: 'ring', maxRadius: 160, progress: 0 });
}
function bossLaserAttack(engine, enemy) {
  const target = pickSpreadTarget(engine, enemy) || nearestPlayer(engine, enemy.x, enemy.y);
  if (!target) return;
  if (beginBossAttack(engine, enemy, 'laser', 0.9, '🔴 Boss charges laser!')) {
    const attack = engine.bossAttacks[enemy.id];
    attack.laserAngle = Math.atan2(target.y - enemy.y, target.x - enemy.x);
    engine.bossWarnings.push({ sourceId: enemy.id, x: enemy.x, y: enemy.y, angle: attack.laserAngle, life: 1.2, type: 'laser', length: 400, progress: 0 });
  }
}
function bossSpawnMinions(engine, enemy) {
  beginBossAttack(engine, enemy, 'minions', 0.8, '👾 Boss summons minions!');
  engine.bossWarnings.push({ sourceId: enemy.id, x: enemy.x, y: enemy.y, life: 0.9, type: 'minions', radius: 40, progress: 0 });
}
function updateBossAttack(engine, enemy, delta) {
  if (!enemy.boss) return;
  const attack = engine.bossAttacks[enemy.id];
  if (!attack || attack.isFinished) return;
  for (const w of engine.bossWarnings) if (w.sourceId === enemy.id) w.progress = 1 - (attack.timer / (attack.warningTimer || 1));

  if (attack.warning) {
    attack.timer -= delta;
    if (attack.timer > 0) return;
    attack.warning = false; attack.attackActive = true;
    if (attack.kind === 'charge') { attack.timer = 0.45; attack.phase = 0.45; }
    else if (attack.kind === 'aoe') { attack.timer = 1.2; attack.phase = 1.2; }
    else if (attack.kind === 'ring') { attack.timer = 0.5; attack.phase = 0.5; }
    else if (attack.kind === 'laser') { attack.timer = 0.5; attack.phase = 0.5; }
    else if (attack.kind === 'minions') { attack.timer = 0.6; attack.phase = 0.6; }
  }
  if (!attack.attackActive) return;
  attack.timer -= delta;

  if (attack.kind === 'charge') {
    const dx = Math.cos(attack.chargeDir), dy = Math.sin(attack.chargeDir);
    enemy.x += dx * 620 * delta; enemy.y += dy * 620 * delta; clampToBorder(enemy);
    if (!attack.hitPlayer) {
      for (const p of alivePlayers(engine)) {
        if (distance(enemy.x, enemy.y, p.x, p.y) < enemy.size + 14) { attack.hitPlayer = true; damagePlayer(engine, p, enemy.damage * 1.4); break; }
      }
    }
    const w = engine.bossWarnings.find(w => w.sourceId === enemy.id && w.type === 'charge');
    if (w) { w.x = enemy.x; w.y = enemy.y; w.angle = attack.chargeDir; w.life = 0.5; }
  } else if (attack.kind === 'aoe') {
    for (const zone of attack.zones) {
      zone.remaining -= delta;
      const w = engine.bossWarnings.find(w => w.sourceId === enemy.id && w.type === 'aoe_zone' && Math.abs(w.x - zone.x) < 1 && Math.abs(w.y - zone.y) < 1);
      if (w) { const prog = 1 - (zone.remaining / 1.2); w.radius = 10 + prog * 55; w.progress = prog; }
      if (!zone.detonated && zone.remaining <= 0) {
        zone.detonated = true;
        for (let j = engine.enemies.length - 1; j >= 0; j--) {
          const e = engine.enemies[j];
          if (!e.boss && !e.dead && distance(zone.x, zone.y, e.x, e.y) < 65 && damageEnemy(engine, e, 25, zone.x, zone.y, false, { noChain: true })) engine.enemies.splice(j, 1);
        }
        for (const p of alivePlayers(engine)) if (distance(zone.x, zone.y, p.x, p.y) < 65) damagePlayer(engine, p, 15);
        const idx = engine.bossWarnings.findIndex(w => w.sourceId === enemy.id && w.type === 'aoe_zone' && Math.abs(w.x - zone.x) < 1 && Math.abs(w.y - zone.y) < 1);
        if (idx !== -1) engine.bossWarnings.splice(idx, 1);
      }
    }
  } else if (attack.kind === 'ring') {
    if (attack.timer <= 0) {
      for (let r = 0; r < 2; r++) for (let i = 0; i < 12; i++) {
        const a = Math.PI * 2 * i / 12 + Math.PI * r + engine.elapsed * 0.6, spd = 140 + Math.random() * 30;
        engine.enemyProjectiles.push({ x: enemy.x, y: enemy.y, vx: Math.cos(a) * spd, vy: Math.sin(a) * spd, life: 2.5, damage: enemy.damage * 0.45, size: 5, color: '#ff8844' });
      }
      finishBossAttack(attack, 2.5, 3.5);
      const idx = engine.bossWarnings.findIndex(w => w.sourceId === enemy.id && w.type === 'ring');
      if (idx !== -1) engine.bossWarnings.splice(idx, 1);
    }
    const w = engine.bossWarnings.find(w => w.sourceId === enemy.id && w.type === 'ring');
    if (w) { w.maxRadius = 70 + (1 - attack.timer / 0.5) * 90; w.progress = 1 - attack.timer / 0.5; }
  } else if (attack.kind === 'laser') {
    const length = 430, bx = enemy.x + Math.cos(attack.laserAngle) * length, by = enemy.y + Math.sin(attack.laserAngle) * length;
    for (const p of alivePlayers(engine)) if (pointToSegmentDistance(p.x, p.y, enemy.x, enemy.y, bx, by) < 18) damagePlayer(engine, p, 8 * delta * 30);
    const w = engine.bossWarnings.find(w => w.sourceId === enemy.id && w.type === 'laser');
    if (w) { w.angle = attack.laserAngle; w.length = length; w.progress = 1 - attack.timer / 0.5; w.life = 0.3; }
    if (attack.timer <= 0) { finishBossAttack(attack, 2.2, 3.2); const idx = engine.bossWarnings.findIndex(w => w.sourceId === enemy.id && w.type === 'laser'); if (idx !== -1) engine.bossWarnings.splice(idx, 1); }
  } else if (attack.kind === 'minions') {
    if (attack.timer <= 0) {
      const count = 2 + Math.floor(Math.random() * 2);
      for (let i = 0; i < count; i++) spawnEnemy(engine, false, 'minion', false);
      finishBossAttack(attack, 3.5, 4.5);
      const idx = engine.bossWarnings.findIndex(w => w.sourceId === enemy.id && w.type === 'minions');
      if (idx !== -1) engine.bossWarnings.splice(idx, 1);
    }
  }
}

function updateEnemySkill(engine, enemy, delta, gap) {
  if (enemy.type === 'grunt' || enemy.type === 'minion') {
    enemy.abilityClock -= delta;
    if (enemy.abilityClock <= 0) {
      enemy.abilityClock = 5.8; enemy.skillFlash = 0.35;
      for (const ally of engine.enemies) {
        if (ally !== enemy && !ally.dead && !ally.boss && distance(enemy.x, enemy.y, ally.x, ally.y) < 210) {
          ally.enrageTimer = Math.max(ally.enrageTimer || 0, 2.8); ally.enrageMultiplier = Math.max(ally.enrageMultiplier || 1, 1.18);
        }
      }
    }
  } else if (enemy.type === 'tank') {
    enemy.abilityClock -= delta;
    if (enemy.abilityClock <= 0) { enemy.abilityClock = 5.2; enemy.shieldTimer = 1.7; enemy.shieldStrength = 0.55; enemy.skillFlash = 0.5; }
  } else if (enemy.type === 'brute') {
    enemy.abilityClock -= delta;
    if (enemy.abilityClock <= 0 && enemy.skillTimer <= 0 && gap < 215) { enemy.abilityClock = 4.9; enemy.skillTimer = 0.58; enemy.skillResolved = false; enemy.skillFlash = 0.58; }
    if (enemy.skillTimer > 0) {
      enemy.skillTimer -= delta;
      if (enemy.skillTimer <= 0 && !enemy.skillResolved) {
        enemy.skillResolved = true;
        const target = engine.players[enemy.targetId];
        if (target && distance(enemy.x, enemy.y, target.x, target.y) < 100) damagePlayer(engine, target, enemy.damage * 1.35);
      }
    }
  }
}

// ---------------------------------------------------------------
// Main tick — runs the whole room's simulation forward by `delta`
// seconds. Called by the server's fixed-step game loop.
// ---------------------------------------------------------------
function tick(engine, delta, onLevelUp) {
  engine.events = [];
  // Freeze the whole simulation while a card vote is in progress or the
  // team has already wiped — mirrors the original single-player pause.
  if (engine.awaitingUpgrade || engine.teamWiped) return;
  if (!engine.doorStarted) startDoor(engine);
  engine.elapsed += delta;

  const players = Object.values(engine.players).filter(p => p.connected);

  // ---- players: movement, aim, auto-attack ----
  for (const p of players) {
    if (!p.alive) continue;
    p.invulnerable = Math.max(0, p.invulnerable - delta);
    p.shotClock -= delta; p.orbitClock -= delta;
    const h = p.input.h || 0, v = p.input.v || 0;
    const len = Math.hypot(h, v) || 1;
    const moving = h !== 0 || v !== 0;
    p.walkCycle += moving ? delta * 9 : delta * 2;
    p.attackKick = Math.max(0, p.attackKick - delta * 4);
    p.x = Math.max(BORDER_MARGIN, Math.min(WORLD_W - BORDER_MARGIN, p.x + (h / len) * p.speed * delta));
    p.y = Math.max(BORDER_MARGIN, Math.min(WORLD_H - BORDER_MARGIN, p.y + (v / len) * p.speed * delta));
    if (p.regen > 0) p.hp = Math.min(p.maxHp, p.hp + p.regen * delta);
    p.scarfAngle += moving ? delta * 3 : delta * 1.5;
    if (p.attackKick > 0.1) p.scarfAngle += delta * 8;

    const effectiveRange = p.range * 0.6;
    let target = null, closest = Infinity;
    for (const enemy of engine.enemies) { const d = distance(p.x, p.y, enemy.x, enemy.y); if (d < closest) { closest = d; target = enemy; } }
    let aimAngle = null, inRange = false;
    if (target) { const dist = distance(p.x, p.y, target.x, target.y); if (dist <= effectiveRange) { inRange = true; aimAngle = Math.atan2(target.y - p.y, target.x - p.x); } }
    else if (p.input.aiming && p.input.aimX != null) {
      const dx = p.input.aimX - p.x, dy = p.input.aimY - p.y;
      if (Math.abs(dx) > 1 || Math.abs(dy) > 1) aimAngle = Math.atan2(dy, dx);
    }
    if (aimAngle !== null) { p.facing = Math.cos(aimAngle) > 0 ? 1 : -1; p.aimAngle = aimAngle; }
    else {
      const restAngle = p.facing === 1 ? 0 : Math.PI;
      let diff = Math.atan2(Math.sin(restAngle - p.aimAngle), Math.cos(restAngle - p.aimAngle));
      const step = delta * 6;
      p.aimAngle = Math.abs(diff) < step ? restAngle : p.aimAngle + Math.sign(diff) * step;
    }

    if (inRange && aimAngle !== null && p.shotClock <= 0) {
      const spread = p.shots > 1 ? 0.13 : 0;
      for (let i = 0; i < p.shots; i++) {
        const off = (i - (p.shots - 1) / 2) * spread;
        const a = aimAngle + off;
        const crit = Math.random() < p.critChance;
        const dmg = p.damage * (crit ? p.critMultiplier : 1);
        engine.projectiles.push({ ownerId: p.id, x: p.x + Math.cos(a) * 12, y: p.y + Math.sin(a) * 12, vx: Math.cos(a) * 320, vy: Math.sin(a) * 320, angle: a, life: 1.2, baseDamage: dmg, damage: dmg, size: crit ? 9 : (p.damage > 17 ? 7 : 5), crit, pierce: p.pierce, pierceCount: 0, hitIds: new Set() });
      }
      p.shotClock = p.fireRate; p.attackKick = 1;
    }

    if (p.orbit > 0 && p.orbitClock <= 0) {
      const orbitSpeed = 2.8;
      for (let k = 0; k < p.orbit; k++) {
        const angle = engine.elapsed * orbitSpeed + (Math.PI * 2 * k) / p.orbit;
        const ox = p.x + Math.cos(angle) * 32, oy = p.y + Math.sin(angle) * 32;
        let hitEnemy = null;
        for (const enemy of engine.enemies) if (distance(ox, oy, enemy.x, enemy.y) < enemy.size + 8) { hitEnemy = enemy; break; }
        if (hitEnemy) {
          const levelBonus = 1 + (engine.teamLevel - 1) * 0.02;
          const killed = damageEnemy(engine, hitEnemy, p.orbitDamage * levelBonus, ox, oy, false, {}, p);
          if (killed) { const idx = engine.enemies.indexOf(hitEnemy); if (idx !== -1) { engine.enemies.splice(idx, 1); if (hitEnemy.boss) delete engine.bossAttacks[hitEnemy.id]; } }
        }
      }
      p.orbitClock = 0.18;
    }

    if (p.lightningDamage > 0 && p.lightningCooldown > 0) {
      p.lightningTimer += delta;
      if (p.lightningTimer >= p.lightningCooldown) {
        p.lightningTimer = 0;
        let biggest = null, biggestHp = -1;
        for (const enemy of engine.enemies) if (enemy.maxHp > biggestHp) { biggestHp = enemy.maxHp; biggest = enemy; }
        if (biggest) {
          const killed = damageEnemy(engine, biggest, p.lightningDamage, p.x, p.y, false, {}, p);
          if (killed) { const idx = engine.enemies.indexOf(biggest); if (idx !== -1) { engine.enemies.splice(idx, 1); if (biggest.boss) delete engine.bossAttacks[biggest.id]; } }
          addEvent(engine, 'lightning', { x: biggest.x, y: biggest.y });
        }
      }
    }
  }

  // ---- spawns ----
  engine.spawnClock -= delta;
  const bossAlive = engine.enemies.some(e => e.boss);
  const cap = 7 + Math.floor((Math.max(1, players.length) - 1) * 3);
  if (!bossAlive && engine.enemies.length < cap && engine.doorKills < engine.doorGoal && engine.spawnClock <= 0) {
    spawnEnemy(engine, false, null, false);
    const teamN = Math.max(1, players.length);
    engine.spawnClock = Math.max(0.7, (2.5 - engine.door * 0.01) / (1 + (teamN - 1) * 0.35));
  }

  // ---- boss attacks ----
  for (const enemy of engine.enemies) {
    if (!enemy.boss) continue;
    const attack = engine.bossAttacks[enemy.id];
    if (!attack) continue;
    updateBossAttack(engine, enemy, delta);
    if (attack.isFinished) attack.cooldown -= delta;
    if (attack.cooldown <= 0 && attack.isFinished && !attack.attackActive && !attack.warning) {
      let chosen = null;
      if (enemy.bossType === 'monarch') chosen = Math.random() < 0.5 ? bossChargeAttack : bossAOEAttack;
      else if (enemy.bossType === 'butcher') { const r = Math.random(); chosen = r < 0.3 ? bossRingAttack : r < 0.6 ? bossLaserAttack : bossSpawnMinions; }
      if (chosen) chosen(engine, enemy, delta);
    }
  }

  // ---- projectiles vs enemies ----
  const splashQueue = [];
  for (let i = engine.projectiles.length - 1; i >= 0; i--) {
    const proj = engine.projectiles[i];
    const owner = engine.players[proj.ownerId];
    proj.x += proj.vx * delta; proj.y += proj.vy * delta; proj.life -= delta;
    let spent = false;
    for (let j = engine.enemies.length - 1; j >= 0; j--) {
      const enemy = engine.enemies[j];
      if (proj.hitIds.has(enemy.id)) continue;
      if (distance(proj.x, proj.y, enemy.x, enemy.y) < enemy.size + proj.size) {
        proj.hitIds.add(enemy.id);
        if (owner && owner.lifesteal > 0) owner.hp = Math.min(owner.maxHp, owner.hp + proj.damage * owner.lifesteal);
        if (owner && owner.splash > 0) splashQueue.push({ x: proj.x, y: proj.y, damage: Math.min(28, Math.max(2, owner.damage * owner.splash)), radius: owner.splash >= 0.25 ? 52 : 42, owner });
        const killed = damageEnemy(engine, enemy, proj.damage, proj.x - proj.vx * 0.01, proj.y - proj.vy * 0.01, proj.crit, {}, owner);
        if (killed && engine.enemies.includes(enemy)) { engine.enemies.splice(engine.enemies.indexOf(enemy), 1); if (enemy.boss) delete engine.bossAttacks[enemy.id]; }
        if (proj.pierce > proj.pierceCount && !killed) { proj.pierceCount++; proj.damage = proj.baseDamage * Math.pow(0.75, proj.pierceCount); }
        else { spent = true; break; }
      }
    }
    if (spent || proj.life <= 0) engine.projectiles.splice(i, 1);
  }
  for (const blast of splashQueue) {
    for (let j = engine.enemies.length - 1; j >= 0; j--) {
      const enemy = engine.enemies[j];
      if (distance(blast.x, blast.y, enemy.x, enemy.y) < blast.radius) {
        const splashDamage = enemy.boss ? blast.damage * 0.65 : blast.damage;
        const killed = damageEnemy(engine, enemy, splashDamage, blast.x, blast.y, false, { noChain: true }, blast.owner);
        if (killed && engine.enemies.includes(enemy)) { engine.enemies.splice(engine.enemies.indexOf(enemy), 1); if (enemy.boss) delete engine.bossAttacks[enemy.id]; }
      }
    }
  }

  // ---- enemies: retarget, move, attack ----
  for (let i = engine.enemies.length - 1; i >= 0; i--) {
    const enemy = engine.enemies[i];
    if (!enemy || enemy.dead) continue;

    enemy.retargetClock -= delta;
    let targetPlayer = enemy.targetId ? engine.players[enemy.targetId] : null;
    if (!targetPlayer || !targetPlayer.connected || !targetPlayer.alive || enemy.retargetClock <= 0) {
      targetPlayer = pickSpreadTarget(engine, enemy);
      enemy.targetId = targetPlayer ? targetPlayer.id : null;
      enemy.retargetClock = 1.2 + Math.random() * 0.8;
    }
    if (!targetPlayer) continue; // no one alive to fight

    const angle = Math.atan2(targetPlayer.y - enemy.y, targetPlayer.x - enemy.x);
    const gap = distance(targetPlayer.x, targetPlayer.y, enemy.x, enemy.y);
    enemy.hitClock -= delta; enemy.flash = Math.max(0, enemy.flash - delta);
    enemy.skillFlash = Math.max(0, (enemy.skillFlash || 0) - delta);
    if (enemy.enrageTimer > 0) enemy.enrageTimer -= delta;
    if (enemy.shieldTimer > 0) enemy.shieldTimer -= delta;
    if (enemy.enrageTimer <= 0) enemy.enrageMultiplier = 1;
    let speedMultiplier = 1;
    updateEnemySkill(engine, enemy, delta, gap);
    if (enemy.enrageTimer > 0) speedMultiplier *= enemy.enrageMultiplier;
    if (enemy.slowTimer > 0) speedMultiplier = 1 - (enemy.slowPercent || 0.15);
    if (enemy.frozen) { speedMultiplier = 0; if (engine.elapsed >= (enemy.freezeUntil || 0)) enemy.frozen = false; }

    if (enemy.poisonTimer > 0) {
      damageEnemy(engine, enemy, (enemy.poisonDamage || 0) * delta, enemy.x, enemy.y, false, { skipEffects: true, skipKnockback: true, showNumber: false });
      enemy.poisonTimer -= delta;
    }
    if (enemy.bleedTimer > 0) {
      damageEnemy(engine, enemy, enemy.bleedDamage * delta, enemy.x, enemy.y, false, { skipEffects: true, skipKnockback: true, showNumber: false });
      enemy.bleedTimer -= delta; if (enemy.bleedTimer <= 0) enemy.bleedDamage = 0;
    }
    if (enemy.hp <= 0) { registerEnemyKill(engine, enemy); engine.enemies.splice(i, 1); if (enemy.boss) delete engine.bossAttacks[enemy.id]; continue; }

    if (!enemy.frozen) {
      if (enemy.type === 'brute') { if (gap > 42) { enemy.x += Math.cos(angle) * enemy.speed * speedMultiplier * 0.82 * delta; enemy.y += Math.sin(angle) * enemy.speed * speedMultiplier * 0.82 * delta; clampToBorder(enemy); } }
      else if (enemy.type === 'splitter') {
        enemy.abilityClock -= delta;
        enemy.x += Math.cos(angle) * enemy.speed * speedMultiplier * delta; enemy.y += Math.sin(angle) * enemy.speed * speedMultiplier * delta; clampToBorder(enemy);
        if (enemy.abilityClock <= 0 && gap < 300) { for (let q = 0; q < 2; q++) { const a = angle + (q === 0 ? -0.55 : 0.55); engine.enemyProjectiles.push({ x: enemy.x, y: enemy.y, vx: Math.cos(a) * 150, vy: Math.sin(a) * 150, life: 1.8, damage: enemy.damage * 0.55, size: 4 }); } enemy.abilityClock = 4.2; }
      } else if (enemy.type === 'assassin') {
        enemy.abilityClock -= delta;
        const mul = gap > 180 ? 1.45 : 0.65;
        enemy.x += Math.cos(angle) * enemy.speed * speedMultiplier * mul * delta; enemy.y += Math.sin(angle) * enemy.speed * speedMultiplier * mul * delta; clampToBorder(enemy);
        if (enemy.abilityClock <= 0 && gap < 420) { enemy.x += Math.cos(angle) * 70; enemy.y += Math.sin(angle) * 70; clampToBorder(enemy); enemy.abilityClock = 2.8; enemy.squish = 0.7; }
      } else if (enemy.type === 'shooter') {
        const desire = gap < 175 ? -1 : gap > 265 ? 1 : 0;
        let moveX = Math.cos(angle) * enemy.speed * speedMultiplier * desire, moveY = Math.sin(angle) * enemy.speed * speedMultiplier * desire;
        let repX = 0, repY = 0;
        for (const other of engine.enemies) {
          if (other === enemy || other.dead) continue;
          const d = distance(enemy.x, enemy.y, other.x, other.y);
          if (d < 80 && d > 0.1) { const force = (80 - d) / 80 * 0.25; const ang = Math.atan2(enemy.y - other.y, enemy.x - other.x); repX += Math.cos(ang) * force; repY += Math.sin(ang) * force; }
        }
        moveX += repX * enemy.speed * 0.8; moveY += repY * enemy.speed * 0.8;
        enemy.x += moveX * delta; enemy.y += moveY * delta; clampToBorder(enemy);
        if (enemy.hitClock <= 0 && gap < 460) { engine.enemyProjectiles.push({ x: enemy.x, y: enemy.y, vx: Math.cos(angle) * 180, vy: Math.sin(angle) * 180, life: 2.5, damage: enemy.damage * 0.72, size: 5 }); enemy.hitClock = 2.25; }
      } else {
        const spdMul = enemy.type === 'charger' && gap > 130 ? 1.35 : 1;
        enemy.x += Math.cos(angle) * enemy.speed * speedMultiplier * spdMul * delta; enemy.y += Math.sin(angle) * enemy.speed * speedMultiplier * spdMul * delta; clampToBorder(enemy);
      }
    }
    if (enemy.slowTimer > 0) enemy.slowTimer -= delta;
    if (gap < enemy.size + 15 && enemy.hitClock <= 0) { enemy.hitClock = 0.8; damagePlayer(engine, targetPlayer, enemy.damage); }
  }

  // ---- enemy projectiles vs players ----
  for (let i = engine.enemyProjectiles.length - 1; i >= 0; i--) {
    const proj = engine.enemyProjectiles[i];
    proj.x += proj.vx * delta; proj.y += proj.vy * delta; proj.life -= delta;
    let hit = false;
    for (const p of alivePlayers(engine)) { if (distance(proj.x, proj.y, p.x, p.y) < proj.size + 12) { damagePlayer(engine, p, proj.damage); hit = true; break; } }
    if (hit || proj.life <= 0 || proj.x < -30 || proj.x > WORLD_W + 30 || proj.y < -30 || proj.y > WORLD_H + 30) engine.enemyProjectiles.splice(i, 1);
  }

  // ---- shards (team XP pool) ----
  for (let i = engine.shards.length - 1; i >= 0; i--) {
    const shard = engine.shards[i];
    const nearest = nearestPlayer(engine, shard.x, shard.y);
    if (nearest) {
      let gap = distance(nearest.x, nearest.y, shard.x, shard.y);
      if (gap < nearest.magnet) { const angle = Math.atan2(nearest.y - shard.y, nearest.x - shard.x), pull = gap < 35 ? 280 : 155; shard.x += Math.cos(angle) * pull * delta; shard.y += Math.sin(angle) * pull * delta; }
      gap = distance(nearest.x, nearest.y, shard.x, shard.y);
      if (gap < 17) { engine.teamXp += Math.round(shard.value * nearest.xpBonus); engine.shards.splice(i, 1); }
    }
  }

  // ---- chests ----
  for (const chest of engine.chests) {
    if (chest.opened) continue;
    const nearest = alivePlayers(engine).find(p => distance(p.x, p.y, chest.x, chest.y) < 25);
    if (nearest) { chest.opened = true; nearest.hp = Math.min(nearest.maxHp, nearest.hp + 18); engine.teamXp += Math.round(8 * (1 + (engine.teamLevel - 1) * 0.08)); addEvent(engine, 'chest', { x: chest.x, y: chest.y }); }
  }

  // ---- boss warnings decay ----
  for (let i = engine.bossWarnings.length - 1; i >= 0; i--) { const w = engine.bossWarnings[i]; w.life -= delta; if (w.life <= 0) engine.bossWarnings.splice(i, 1); }

  // ---- door clear ----
  if (engine.doorKills >= engine.doorGoal && engine.enemies.length === 0 && !engine.doorCleared) {
    engine.doorCleared = true; engine.door++; engine.doorStarted = false; engine.doorKills = 0;
    engine.chests = []; engine.projectiles = []; engine.enemyProjectiles = []; engine.bossWarnings = [];
    startDoor(engine);
    addEvent(engine, 'announce', { message: `Door ${engine.door} opened` });
  }

  // ---- team level up -> vote ----
  if (engine.teamXp >= engine.teamNextXp && !engine.awaitingUpgrade) {
    engine.teamXp -= engine.teamNextXp;
    engine.teamLevel++;
    engine.teamNextXp = Math.floor(35 + Math.pow(engine.teamLevel, 1.35) * 8);
    engine.awaitingUpgrade = true;
    const choices = pickUpgrades(engine.door);
    if (onLevelUp) onLevelUp(choices);
  }

  // ---- game over check: whole team wiped ----
  const anyAlive = Object.values(engine.players).some(p => p.connected && p.alive);
  const hasAnyPlayer = Object.values(engine.players).some(p => p.connected);
  engine.teamWiped = hasAnyPlayer && !anyAlive;
}

function resolveUpgradeVote(engine, winningId) {
  for (const p of Object.values(engine.players)) applyUpgradeById(p, winningId);
  engine.awaitingUpgrade = false;
}

function readHudFor(engine, playerId) {
  const p = engine.players[playerId];
  if (!p) return null;
  return { hp: p.hp, maxHp: p.maxHp, xp: engine.teamXp, nextXp: engine.teamNextXp, level: engine.teamLevel, kills: engine.totalKills, door: engine.door, doorKills: engine.doorKills, doorGoal: engine.doorGoal };
}

module.exports = {
  WORLD_W, WORLD_H, BORDER_MARGIN, VOTE_TIMEOUT_SECONDS,
  createEngine, createPlayer, tick, pickUpgrades, resolveUpgradeVote, readHudFor,
  alivePlayers, upgradePool,
};
