use wasm_bindgen::prelude::*;
use serde::{Serialize, Deserialize};

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = Math)]
    fn random() -> f64;
}

fn clamp(n: f64, a: f64, b: f64) -> f64 {
    n.max(a).min(b)
}

fn smoothstep01(x: f64) -> f64 {
    let t = clamp(x, 0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

fn dist2(ax: f64, ay: f64, bx: f64, by: f64) -> f64 {
    let dx = ax - bx;
    let dy = ay - by;
    dx * dx + dy * dy
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq)]
pub enum Phase {
    Menu,
    Play,
    Over,
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq)]
pub enum Difficulty {
    Easy,
    Medium,
    Hard,
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq)]
pub enum EnemyType {
    Scout,
    Zigzag,
    Tank,
    Boss,
    Kamikaze,
    Bomb,
}


#[derive(Serialize, Deserialize, Clone)]
pub struct Particle {
    pub x: f64,
    pub y: f64,
    pub vx: f64,
    pub vy: f64,
    pub life: f64,
    pub max_life: f64,
}

#[derive(Serialize, Deserialize, Clone, PartialEq)]
pub enum PowerupType {
    Overdrive,
    Drones,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Powerup {
    pub id: u32,
    pub x: f64,
    pub y: f64,
    pub vy: f64,
    pub t: PowerupType,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Enemy {
    pub id: u32,
    pub t: EnemyType,
    pub x: f64,
    pub y: f64,
    pub vx: f64,
    pub vy: f64,
    pub r: f64,
    pub hp: f64,
    pub max_hp: f64,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Bullet {
    pub id: u32,
    pub x: f64,
    pub y: f64,
    pub vx: f64,
    pub vy: f64,
}

#[derive(Serialize, Deserialize)]
pub struct GameState {
    pub phase: Phase,
    pub score: f64,
    pub px: f64,
    pub py: f64,
    pub tx: f64,
    pub w: f64,
    pub h: f64,
    pub dpr: f64,
    
    pub enemies: Vec<Enemy>,
    pub particles: Vec<Particle>,
    pub powerups: Vec<Powerup>,
    pub shake: f64,
    pub bullets: Vec<Bullet>,
    
    // Extracted state for drawing so TS doesn't need to rebuild it
    pub flame: bool,
    pub drones: bool,
}

struct DiffConfig {
    ramp_ms: f64,
    spawn_base_ms: f64,
    spawn_min_factor: f64,
    speed_mul: f64,
    hp_mul: f64,
    fire_interval_ms: f64,
    boss_every_ms: f64,
    boss_hp: f64,
    boss_damage_mul: f64,
}

impl DiffConfig {
    fn get(d: Difficulty) -> Self {
        match d {
            Difficulty::Easy => DiffConfig {
                ramp_ms: 140_000.0,
                spawn_base_ms: 1400.0,
                spawn_min_factor: 0.86,
                speed_mul: 0.80,
                hp_mul: 0.85,
                fire_interval_ms: 78.0,
                boss_every_ms: 70_000.0,
                boss_hp: 6.0,
                boss_damage_mul: 1.2,
            },
            Difficulty::Medium => DiffConfig {
                ramp_ms: 115_000.0,
                spawn_base_ms: 1150.0,
                spawn_min_factor: 0.78,
                speed_mul: 0.92,
                hp_mul: 0.98,
                fire_interval_ms: 86.0,
                boss_every_ms: 62_000.0,
                boss_hp: 9.0,
                boss_damage_mul: 1.25,
            },
            Difficulty::Hard => DiffConfig {
                ramp_ms: 95_000.0,
                spawn_base_ms: 980.0,
                spawn_min_factor: 0.70,
                speed_mul: 1.0,
                hp_mul: 1.05,
                fire_interval_ms: 96.0,
                boss_every_ms: 55_000.0,
                boss_hp: 12.0,
                boss_damage_mul: 1.3,
            },
        }
    }
}

#[wasm_bindgen]
pub struct GameEngine {
    w: f64,
    h: f64,
    dpr: f64,
    phase: Phase,
    diff: Difficulty,
    
    start_at: f64,
    last_at: f64,
    
    px: f64,
    py: f64,
    tx: f64,
    
    enemies: Vec<Enemy>,
    bullets: Vec<Bullet>,
    particles: Vec<Particle>,
    powerups: Vec<Powerup>,
    shake: f64,
    
    next_spawn_at: f64,
    next_boss_at: f64,
    last_shot_at: f64,
    
    score: f64,
    overdrive_until: f64,
    drones_until: f64,
    next_id: u32,
}

#[wasm_bindgen]
impl GameEngine {
    #[wasm_bindgen(constructor)]
    pub fn new() -> GameEngine {
        GameEngine {
            w: 800.0,
            h: 600.0,
            dpr: 1.0,
            phase: Phase::Menu,
            diff: Difficulty::Easy,
            
            start_at: 0.0,
            last_at: 0.0,
            
            px: 400.0,
            py: 500.0,
            tx: 400.0,
            
            enemies: Vec::new(),
            particles: Vec::new(),
            powerups: Vec::new(),
            shake: 0.0,
            bullets: Vec::new(),
            
            next_spawn_at: 0.0,
            next_boss_at: 0.0,
            last_shot_at: 0.0,
            
            score: 0.0,
            overdrive_until: 0.0,
            drones_until: 0.0,
            next_id: 1,
        }
    }

    pub fn resize(&mut self, w: f64, h: f64, dpr: f64) {
        self.w = w;
        self.h = h;
        self.dpr = dpr;
        
        // Update py when resized, similar to TS
        self.py = (h * 0.86).floor();
        if self.phase != Phase::Play {
            self.px = (w * 0.5).floor();
            self.tx = self.px;
        }
    }

    pub fn reset(&mut self, phase_str: &str, diff_str: &str, time: f64) {
        self.phase = match phase_str {
            "menu" => Phase::Menu,
            "play" => Phase::Play,
            _ => Phase::Over,
        };
        self.diff = match diff_str {
            "easy" => Difficulty::Easy,
            "medium" => Difficulty::Medium,
            _ => Difficulty::Hard,
        };
        
        self.enemies.clear();
        self.particles.clear();
        self.powerups.clear();
        self.shake = 0.0;
        self.bullets.clear();
        self.next_id = 1;
        self.score = 0.0;
        self.overdrive_until = 0.0;
        
        let d = DiffConfig::get(self.diff);
        self.start_at = time;
        self.last_at = time;
        self.next_spawn_at = time + 450.0;
        self.next_boss_at = time + d.boss_every_ms;
        self.last_shot_at = 0.0;
        
        self.px = (self.w * 0.5).floor();
        self.tx = self.px;
    }

    pub fn set_target_x(&mut self, x: f64) {
        self.tx = clamp(x, 24.0 * self.dpr, self.w - 24.0 * self.dpr);
    }
    
    pub fn update(&mut self, time: f64) {
        let dt = ((time - self.last_at) / 1000.0).max(0.0).min(0.033);
        self.last_at = time;
        
        if self.phase == Phase::Play {
            // Player movement
            let follow = match self.diff {
                Difficulty::Easy => 15.0,
                Difficulty::Medium => 14.0,
                Difficulty::Hard => 13.0,
            };
            self.px += (self.tx - self.px) * clamp(dt * follow, 0.0, 1.0);
            
            // Shooting
            self.shoot(time);
            
            // Spawning
            if time >= self.next_spawn_at {
                self.spawn_enemy(time);
            }
            
            let boss_alive = self.enemies.iter().any(|e| e.t == EnemyType::Boss);
            if !boss_alive && time >= self.next_boss_at {
                self.spawn_boss(time);
            }
            if boss_alive && random() < 0.035 {
                let mut bx = 0.0;
                let mut by = 0.0;
                for e in &self.enemies {
                    if e.t == EnemyType::Boss {
                        bx = e.x;
                        by = e.y;
                        break;
                    }
                }
                if bx > 0.0 {
                    self.enemies.push(Enemy {
                        id: self.next_id,
                        t: EnemyType::Bomb,
                        x: bx + (random() - 0.5) * 40.0 * self.dpr,
                        y: by + 30.0 * self.dpr,
                        vx: 0.0,
                        vy: 220.0 * self.dpr,
                        r: 9.0 * self.dpr,
                        hp: 1.0,
                        max_hp: 1.0,
                    });
                    self.next_id += 1;
                }
            }
            
            self.move_entities(time, dt);
            self.check_collisions(time);
        }
    }
    
    pub fn get_state(&self) -> JsValue {
        let state = GameState {
            phase: self.phase,
            score: self.score,
            px: self.px,
            py: self.py,
            tx: self.tx,
            w: self.w,
            h: self.h,
            dpr: self.dpr,
            enemies: self.enemies.clone(),
            particles: self.particles.clone(),
            powerups: self.powerups.clone(),
            shake: self.shake,
            bullets: self.bullets.clone(),
            flame: self.phase == Phase::Play,
            drones: self.last_at < self.drones_until,
        };
        serde_wasm_bindgen::to_value(&state).unwrap()
    }
}

// Internal logic
impl GameEngine {
    fn shoot(&mut self, t: f64) {
        let d = DiffConfig::get(self.diff);
        let overdrive = t < self.overdrive_until;
        let interval = if overdrive { (d.fire_interval_ms - 26.0).max(66.0) } else { d.fire_interval_ms };
        
        if t - self.last_shot_at < interval {
            return;
        }
        self.last_shot_at = t;
        
        let speed = -920.0 * self.dpr;
        let dual = overdrive;
        let spread = if dual { 10.0 * self.dpr } else { 0.0 };
        
        self.bullets.push(Bullet {
            id: self.next_id,
            x: self.px - spread,
            y: self.py - 26.0 * self.dpr,
            vx: 0.0,
            vy: speed,
        });
        self.next_id += 1;
        
        if dual {
            self.bullets.push(Bullet {
                id: self.next_id,
                x: self.px + spread,
                y: self.py - 26.0 * self.dpr,
                vx: 0.0,
                vy: speed,
            });
            self.next_id += 1;
        }
        
        if t < self.drones_until {
            self.bullets.push(Bullet {
                id: self.next_id,
                x: self.px - 36.0 * self.dpr,
                y: self.py + 10.0 * self.dpr,
                vx: 0.0,
                vy: speed,
            });
            self.next_id += 1;
            
            self.bullets.push(Bullet {
                id: self.next_id,
                x: self.px + 36.0 * self.dpr,
                y: self.py + 10.0 * self.dpr,
                vx: 0.0,
                vy: speed,
            });
            self.next_id += 1;
        }
    }

    fn spawn_enemy(&mut self, t: f64) {
        let d = DiffConfig::get(self.diff);
        let ramp_raw = (t - self.start_at) / d.ramp_ms;
        let ramp = smoothstep01(ramp_raw);
        let spawn_ms = d.spawn_base_ms * (1.0 - (1.0 - d.spawn_min_factor) * ramp);
        
        self.next_spawn_at = t + spawn_ms;
        
        let r_val = random();
        let et = match self.diff {
            Difficulty::Easy => if r_val < 0.60 { EnemyType::Scout } else if r_val < 0.80 { EnemyType::Zigzag } else if r_val < 0.92 { EnemyType::Kamikaze } else { EnemyType::Tank },
            Difficulty::Medium => if r_val < 0.50 { EnemyType::Scout } else if r_val < 0.75 { EnemyType::Zigzag } else if r_val < 0.88 { EnemyType::Kamikaze } else { EnemyType::Tank },
            Difficulty::Hard => if r_val < 0.40 { EnemyType::Scout } else if r_val < 0.68 { EnemyType::Zigzag } else if r_val < 0.85 { EnemyType::Kamikaze } else { EnemyType::Tank },
        };
        
        let x = clamp(random() * self.w, 30.0 * self.dpr, self.w - 30.0 * self.dpr);
        let mut hp = 1.0;
        let mut r = 14.0 * self.dpr;
        let mut vy = (220.0 + 180.0 * ramp) * self.dpr * d.speed_mul;
        let mut vx = 0.0;
        
        match et {
            EnemyType::Scout => {
                hp = (1.0 * d.hp_mul).round().max(1.0);
                vy *= 1.08;
            },
            EnemyType::Zigzag => {
                hp = (1.0 * d.hp_mul).round().max(1.0);
                r = 15.0 * self.dpr;
                vy *= 0.95;
                vx = if random() < 0.5 { -1.0 } else { 1.0 } * (120.0 + 100.0 * ramp) * self.dpr * d.speed_mul;
            },
            EnemyType::Tank => {
                hp = (2.0 * d.hp_mul).round().max(2.0);
                r = 17.0 * self.dpr;
                vy *= 0.80;
            },
            EnemyType::Kamikaze => {
                hp = (1.0 * d.hp_mul).round().max(1.0);
                r = 12.0 * self.dpr;
                vy *= 1.35;
            },
            _ => {}
        }
        
        self.enemies.push(Enemy {
            id: self.next_id,
            t: et,
            x,
            y: -44.0 * self.dpr,
            vx,
            vy,
            r,
            hp,
            max_hp: hp,
        });
        self.next_id += 1;
    }

    fn spawn_boss(&mut self, t: f64) {
        let d = DiffConfig::get(self.diff);
        self.next_boss_at = t + d.boss_every_ms;
        
        let hp = d.boss_hp;
        self.enemies.push(Enemy {
            id: self.next_id,
            t: EnemyType::Boss,
            x: self.w * 0.5,
            y: -70.0 * self.dpr,
            vx: 0.0,
            vy: 120.0 * self.dpr * d.speed_mul,
            r: 36.0 * self.dpr,
            hp,
            max_hp: hp,
        });
        self.next_id += 1;
    }

    fn move_entities(&mut self, t: f64, dt: f64) {
        self.shake = (self.shake - dt * 25.0).max(0.0);
        
        for p in &mut self.particles {
            p.x += p.vx * dt;
            p.y += p.vy * dt;
            p.life -= dt;
        }
        self.particles.retain(|p| p.life > 0.0);
        
        for p in &mut self.powerups {
            p.y += p.vy * dt * self.dpr;
        }
        self.powerups.retain(|p| p.y < self.h + 50.0 * self.dpr);
        
        for b in &mut self.bullets {
            b.x += b.vx * dt;
            b.y += b.vy * dt;
        }
        self.bullets.retain(|b| b.y > -60.0 * self.dpr);
        
        for e in &mut self.enemies {
            if e.t == EnemyType::Boss {
                let target_y = 120.0 * self.dpr;
                if e.y < target_y {
                    e.y += e.vy * dt;
                } else {
                    e.y += (t * 0.002).sin() * 9.0 * self.dpr * dt;
                }
                e.x = self.w * 0.5 + (t * 0.0012).sin() * (self.w * 0.18);
            } else if e.t == EnemyType::Kamikaze {
                e.y += e.vy * dt;
                let follow = 2.0;
                e.x += (self.px - e.x) * clamp(dt * follow, 0.0, 1.0);
            } else if e.t == EnemyType::Bomb {
                e.y += e.vy * dt;
            } else {
                e.y += e.vy * dt;
                e.x += e.vx * dt;
                
                if e.t == EnemyType::Zigzag {
                    if e.x < 24.0 * self.dpr || e.x > self.w - 24.0 * self.dpr {
                        e.vx *= -1.0;
                        e.x = clamp(e.x, 24.0 * self.dpr, self.w - 24.0 * self.dpr);
                    }
                }
            }
        }
    }

    fn check_collisions(&mut self, t: f64) {
        // Enforce bottom edge
        for e in &self.enemies {
            if e.y + e.r >= self.h {
                self.phase = Phase::Over;
                break;
            }
        }
        
        if self.phase == Phase::Over {
            return;
        }
        
        // Bullet -> Enemy collisions
        let d = DiffConfig::get(self.diff);
        let mut alive_bullets = Vec::new();
        
        for b in &self.bullets {
            let mut hit = false;
            for e in &mut self.enemies {
                if e.hp <= 0.0 { continue; } // Already dead
                
                let rr = (if e.t == EnemyType::Boss { 0.85 } else { 0.92 }) * e.r + 6.0 * self.dpr;
                if dist2(b.x, b.y, e.x, e.y) <= rr * rr {
                    hit = true;
                    
                    let dmg = if e.t == EnemyType::Boss { d.boss_damage_mul } else { 1.0 };
                    e.hp -= dmg;
                    
                    if e.hp <= 0.0 {
                        // Spawn particles
                        for _ in 0..10 {
                            self.particles.push(Particle {
                                x: e.x + (random() - 0.5) * 20.0 * self.dpr,
                                y: e.y + (random() - 0.5) * 20.0 * self.dpr,
                                vx: (random() - 0.5) * 350.0 * self.dpr,
                                vy: (random() - 0.5) * 350.0 * self.dpr,
                                life: 0.2 + random() * 0.3,
                                max_life: 0.5,
                            });
                        }
                        
                        if e.t == EnemyType::Boss {
                            self.score += 520.0;
                            self.overdrive_until = t + 6500.0;
                            self.shake += 12.0;
                        } else if e.t == EnemyType::Tank {
                            self.score += 35.0;
                            self.shake += 2.0;
                        } else {
                            self.score += 20.0;
                        }
                        
                        // Drop powerup
                        if random() < 0.08 {
                            self.powerups.push(Powerup {
                                id: self.next_id,
                                x: e.x,
                                y: e.y,
                                vy: 80.0,
                                t: if random() < 0.5 { PowerupType::Overdrive } else { PowerupType::Drones },
                            });
                            self.next_id += 1;
                        }
                    } else {
                        self.score += if e.t == EnemyType::Boss { 2.0 } else { 1.0 };
                    }
                    break;
                }
            }
            if !hit {
                alive_bullets.push(b.clone());
            }
        }
        self.bullets = alive_bullets;
        
        self.enemies.retain(|e| e.hp > 0.0 && e.y < self.h + 100.0 * self.dpr);
        
        // Player collision
        let player_hit_r = 13.0 * self.dpr;
        for e in &self.enemies {
            let enemy_hit_r = if e.t == EnemyType::Boss { e.r * 0.82 } else { e.r * 0.90 };
            let rr = enemy_hit_r + player_hit_r;
            if dist2(self.px, self.py, e.x, e.y) <= rr * rr {
                self.phase = Phase::Over;
                self.shake += 15.0;
                break;
            }
        }
        
        // Powerup collection
        for p in &mut self.powerups {
            if dist2(self.px, self.py, p.x, p.y) <= 800.0 * self.dpr * self.dpr { 
                p.y = 9999.0; // mark collected
                if p.t == PowerupType::Overdrive {
                    self.overdrive_until = t + 6000.0; 
                } else {
                    self.drones_until = t + 12000.0;
                }
                self.score += 50.0;
                self.shake += 5.0;
            }
        }
    }
}
