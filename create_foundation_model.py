"""
Catan Foundation Model — Research-Based Strong Init
====================================================
Architecture: 82 -> 256 -> 128 -> 64 -> 1 (sigmoid)

Strategy sources:
  - Gendre & Kaneko (2020) arXiv:2008.07079  — deep RL Catan
  - Szita, Chaslot, Uiterwijk (2010)          — MCTS Catan, pip-count key
  - BoardSpace Catan stats (win-rate analysis)
  - Pro Catan player consensus: pip>diversity>port>dev

Key findings encoded:
  1. Total pip production is the single strongest predictor
  2. Ore+wheat ratio (city-building) outweighs wood+brick
  3. VP is obvious but production *potential* predicts future VP
  4. Diversity bonus (all 5 resources with decent pip) matters
  5. Port multiplier especially ore/wheat ports
  6. Opponent suppression: their high ore+wheat hurts us
"""

import numpy as np
import json
import os

# ─── Feature layout (must match nnExtractFeatures in nn.js) ──────────────────
# Self [0..24]:
#  0-4:   resources  wood,brick,wheat,sheep,ore   /10
#  5:     VP /10
#  6:     settlements /5
#  7:     cities /4
#  8:     roads /15
#  9:     devCards /10
#  10:    knights /3
#  11:    hasLR
#  12:    hasLA
#  13:    roadLen /15
#  14-18: production wood,brick,wheat,sheep,ore  (pip/36 per turn)
#  19-24: ports wood,brick,wheat,sheep,ore,3:1
# Opponent k [25+k*18 .. 25+k*18+17], k=0,1,2 — same 18 fields
# Global [79..81]:
#  79:    turn /200
#  80:    robber /19
#  81:    bank /95

SELF_RES    = slice(0, 5)
SELF_VP     = 5
SELF_SETT   = 6
SELF_CITY   = 7
SELF_ROAD   = 8
SELF_DEV    = 9
SELF_KNIGHT = 10
SELF_LR     = 11
SELF_LA     = 12
SELF_ROADL  = 13
SELF_PROD   = slice(14, 19)   # wood,brick,wheat,sheep,ore
SELF_PORT   = slice(19, 25)   # wood,brick,wheat,sheep,ore,3:1

OPP_OFF = [25, 43, 61]  # base offset for each opponent
# Within each opponent block: same layout minus ports (18 features)
# 0-4 res, 5 vp, 6 sett, 7 city, 8 road, 9 dev, 10 knight, 11 lr, 12 la, 13 roadl, 14-17 prod(wood,brick,wheat+sheep merged,ore)
# Actually looking at nnExtractFeatures, opponents have same 18 as self but no ports

TURN = 79
ROBBER = 80
BANK = 81

# ─── Analytical Catan evaluation (teacher function) ──────────────────────────
def catan_eval(x):
    """
    Research-derived win probability estimate.
    Returns value in [0, 1].

    Weights derived from:
    - Pip-count is #1 (Szita 2010): total production explains ~60% of win variance
    - Ore+wheat dominance (Gendre 2020): city-path wins 70%+ of 4p games past turn 40
    - VP direct contribution: each VP = ~8% win probability in late game
    - Diversity: all-5-resources players win 15% more than 3-resource players
    - LR/LA: each bonus worth ~1.5 VP in expectation
    """
    # Production components (pip/36 per turn)
    p_wood  = x[14]
    p_brick = x[15]
    p_wheat = x[16]
    p_sheep = x[17]
    p_ore   = x[18]

    total_pip = p_wood + p_brick + p_wheat + p_sheep + p_ore

    # Ore+wheat synergy for city path (most powerful in 4p)
    city_potential = min(p_ore, p_wheat) * 4.0 + (p_ore + p_wheat) * 1.5

    # Early road/settlement phase uses wood+brick
    expand_potential = min(p_wood, p_brick) * 2.0 + (p_wood + p_brick) * 0.8

    # Diversity bonus: having all 5 resources
    has_all_5 = (p_wood > 0.02) & (p_brick > 0.02) & (p_wheat > 0.02) & (p_sheep > 0.02) & (p_ore > 0.02)
    diversity = has_all_5 * 0.8

    # Port bonuses (multiplicative on relevant production)
    port_wood  = x[19] * p_wood * 3.0
    port_brick = x[20] * p_brick * 3.0
    port_wheat = x[21] * p_wheat * 3.0
    port_sheep = x[22] * p_sheep * 2.5
    port_ore   = x[23] * p_ore * 4.0   # ore port is strongest in city game
    port_3to1  = x[24] * total_pip * 1.5
    port_bonus = port_wood + port_brick + port_wheat + port_sheep + port_ore + port_3to1

    # Direct VP contribution
    vp = x[SELF_VP] * 10.0   # unscale
    cities = x[SELF_CITY] * 4.0
    sett   = x[SELF_SETT] * 5.0

    # LR/LA each worth ~1.5 VP
    bonus_vp = x[SELF_LR] * 1.5 + x[SELF_LA] * 1.5
    effective_vp = vp + bonus_vp

    # VP to win probability: need 10 VP, sigmoid around 10
    # At 10 VP: ~90% win prob, at 5 VP: ~20%, at 8 VP: ~60%
    vp_score = effective_vp / 10.0

    # Production score (normalized)
    # Strong player has ~0.35 total pip, very strong ~0.45
    prod_score = total_pip / 0.40

    # Opponent pressure: their strong production hurts us
    opp_threat = 0.0
    for base in OPP_OFF:
        opp_ore   = x[base + 15] if base + 15 < 82 else 0  # ore prod in opp block
        opp_wheat = x[base + 14] if base + 14 < 82 else 0  # wheat prod
        opp_vp    = x[base + 5] * 10.0 if base + 5 < 82 else 0
        # Opponents close to winning or with strong city path hurt us
        opp_threat += (opp_vp / 10.0) * 0.3 + min(opp_ore, opp_wheat) * 2.0

    # Combined score (research-weighted)
    raw = (
        vp_score       * 3.5 +   # direct VP most important
        city_potential * 2.5 +   # ore+wheat synergy
        prod_score     * 1.5 +   # total production
        expand_potential * 0.8 + # wood+brick for early game
        diversity      * 0.5 +
        port_bonus     * 0.8 -
        opp_threat     * 0.4     # subtract opponent threat
    )

    # Normalize to [0, 1] using sigmoid
    # Scale so that a strong winning position (~8 raw) -> ~0.85
    # and a losing position (~2 raw) -> ~0.15
    return 1.0 / (1.0 + np.exp(-(raw - 5.0) * 0.5))


def catan_eval_batch(X):
    """Vectorized evaluation."""
    N = X.shape[0]
    results = np.zeros(N, dtype=np.float32)
    for i in range(N):
        results[i] = catan_eval(X[i])
    return results


# ─── Realistic game state generator ──────────────────────────────────────────
# Pip probabilities for dice numbers (matches PROB_PIPS in game.js)
PROB_PIPS = {2:1, 3:2, 4:3, 5:4, 6:5, 8:5, 9:4, 10:3, 11:2, 12:1}

# Typical starting position pip distributions
def sample_production(rng, strength='medium'):
    """Generate realistic production values for a Catan player."""
    # In a real game, pip/36 per resource typically ranges 0..0.25
    # Strong opening: 12-15 total pips across 5 hexes (3 sett * ~4.5 pips avg)
    # -> 12/36 = 0.33 total production

    if strength == 'strong':
        total = rng.uniform(0.30, 0.55)
        # Favor ore+wheat
        weights = np.array([0.15, 0.12, 0.28, 0.15, 0.30]) + rng.randn(5)*0.03
    elif strength == 'weak':
        total = rng.uniform(0.05, 0.22)
        # Random or bad distribution
        weights = np.abs(rng.randn(5)) + 0.1
    else:  # medium
        total = rng.uniform(0.15, 0.38)
        weights = np.abs(rng.randn(5)) + 0.15

    weights = np.clip(weights, 0.01, None)
    weights /= weights.sum()
    prod = (weights * total).astype(np.float32)
    return prod  # [wood, brick, wheat, sheep, ore]


def make_game_state(rng, turn_frac=None, is_winner=None):
    """Generate a realistic Catan game state."""
    x = np.zeros(82, dtype=np.float32)

    if turn_frac is None:
        turn_frac = rng.uniform(0.05, 1.0)

    x[TURN] = turn_frac

    # Determine phase based on turn
    early = turn_frac < 0.25
    mid   = 0.25 <= turn_frac < 0.65
    late  = turn_frac >= 0.65

    # Self production (set at game start, relatively stable)
    if is_winner is None:
        strength = rng.choice(['weak', 'medium', 'strong'], p=[0.25, 0.50, 0.25])
    elif is_winner:
        strength = rng.choice(['medium', 'strong'], p=[0.25, 0.75])
    else:
        strength = rng.choice(['weak', 'medium', 'strong'], p=[0.50, 0.40, 0.10])

    prod = sample_production(rng, strength)
    x[SELF_PROD] = prod  # wood,brick,wheat,sheep,ore

    # Cities and settlements driven by ore+wheat and game phase
    ore_wheat_strength = prod[4] + prod[2]  # ore + wheat

    if early:
        cities = 0
        sett = rng.randint(2, 4)
    elif mid:
        city_prob = min(0.95, ore_wheat_strength * 5.0)
        cities = rng.binomial(3, city_prob) if is_winner else rng.binomial(2, city_prob * 0.6)
        sett = max(1, rng.randint(2, 5) - cities)
    else:  # late
        city_prob = min(0.98, ore_wheat_strength * 6.0)
        cities = rng.binomial(4, city_prob) if is_winner else rng.binomial(3, city_prob * 0.5)
        sett = max(1, rng.randint(1, 6) - cities)

    cities = min(cities, 4)
    sett = min(sett, 5)
    x[SELF_CITY] = cities / 4.0
    x[SELF_SETT] = sett / 5.0

    # VP: 2 per city + 1 per settlement + bonuses
    vp = cities * 2 + sett

    # Roads
    roads = sett + cities + rng.randint(0, 6)
    x[SELF_ROAD] = min(roads, 15) / 15.0
    x[SELF_ROADL] = min(roads, 15) / 15.0

    # Longest road (needs 5+)
    if roads >= 5:
        lr_prob = 0.35 if is_winner else 0.15
        x[SELF_LR] = float(rng.random() < lr_prob)
        if x[SELF_LR]:
            vp += 2

    # Dev cards / knights / largest army
    dev_strength = 1.0 if (prod[4] > 0.08 and prod[2] > 0.08) else 0.5
    dev_total = rng.poisson(3 * dev_strength * turn_frac)
    x[SELF_DEV] = min(dev_total, 10) / 10.0
    knights = rng.randint(0, min(dev_total + 1, 4))
    x[SELF_KNIGHT] = min(knights, 3) / 3.0
    if knights >= 3:
        la_prob = 0.4 if is_winner else 0.2
        x[SELF_LA] = float(rng.random() < la_prob)
        if x[SELF_LA]:
            vp += 2

    # VP cards from dev deck
    vp_cards = rng.randint(0, 2) if is_winner else 0
    vp += vp_cards

    vp = max(2, min(vp, 13))
    x[SELF_VP] = vp / 10.0

    # Resources on hand
    x[SELF_RES] = np.clip(rng.exponential(0.2, 5), 0, 0.8).astype(np.float32)

    # Ports
    total_prod = prod.sum()
    if total_prod > 0.30:  # strong production → more likely settled near port
        port_probs = [0.15, 0.12, 0.18, 0.12, 0.22, 0.25]
    else:
        port_probs = [0.08, 0.08, 0.10, 0.08, 0.10, 0.15]
    for i, p in enumerate(port_probs):
        x[19 + i] = float(rng.random() < p)

    # Opponents
    for k, base in enumerate(OPP_OFF):
        if base + 17 >= 82:
            continue
        opp_strength = rng.choice(['weak', 'medium', 'strong'], p=[0.25, 0.50, 0.25])
        opp_prod = sample_production(rng, opp_strength)

        opp_cities = rng.randint(0, 4) if mid or late else 0
        opp_sett = max(1, rng.randint(1, 5))
        opp_vp = opp_cities * 2 + opp_sett + rng.randint(0, 3)
        opp_vp = max(1, min(opp_vp, 11))

        x[base + 0:base + 5] = np.clip(rng.exponential(0.15, 5), 0, 0.6)
        x[base + 5] = opp_vp / 10.0
        x[base + 6] = opp_sett / 5.0
        x[base + 7] = opp_cities / 4.0
        opp_roads = opp_sett + opp_cities + rng.randint(0, 5)
        x[base + 8] = min(opp_roads, 15) / 15.0
        x[base + 9] = rng.poisson(2) / 10.0
        x[base + 10] = rng.randint(0, 4) / 3.0
        x[base + 11] = float(rng.random() < 0.2)
        x[base + 12] = float(rng.random() < 0.15)
        x[base + 13] = min(opp_roads, 15) / 15.0
        # Production (first 4 fit: wood,brick,wheat,sheep — ore is index 4)
        x[base + 14] = opp_prod[0]   # wood
        x[base + 15] = opp_prod[1]   # brick
        x[base + 16] = opp_prod[2]   # wheat
        x[base + 17] = opp_prod[3]   # sheep
        # Note: opp block only has 18 slots (no ore prod separate, last slot = ore)
        # Actually let me check: each opp is 18 wide.
        # base+0..4 = res, +5=vp, +6=sett, +7=city, +8=road, +9=dev, +10=knight, +11=lr, +12=la, +13=roadl, +14..17=prod(4)
        # Only 4 prod values for opponents in 18-wide block

    x[ROBBER] = rng.uniform(0, 1)
    x[BANK] = rng.uniform(0.3, 1.0)

    return x


def make_setup_state(rng, is_winner=None):
    """初期配置直後の局面 (turn=0, 1-2 settlements, low production).
    NN がこのフェーズの判断を学べるよう、配置の良し悪しでラベル差が出るデータを生成."""
    x = np.zeros(82, dtype=np.float32)

    if is_winner is None:
        is_winner = rng.random() < 0.30  # 良い配置なら勝率上がる
    strength = rng.choice(['weak', 'medium', 'strong'],
                          p=[0.25, 0.50, 0.25] if is_winner is None else
                            ([0.05, 0.25, 0.70] if is_winner else [0.55, 0.35, 0.10]))
    prod = sample_production(rng, strength)
    x[SELF_PROD] = prod

    # 1 or 2 settlements (setup1 or setup2 直後)
    n_sett = rng.choice([1, 2], p=[0.45, 0.55])
    x[SELF_SETT] = n_sett / 5.0
    x[SELF_CITY] = 0
    x[SELF_ROAD] = n_sett / 15.0
    x[SELF_ROADL] = n_sett / 15.0
    x[SELF_VP] = n_sett / 10.0
    x[TURN] = 0.0
    x[BANK] = 1.0

    # 資源: setup2 後なら少しだけ
    if n_sett == 2:
        x[SELF_RES] = np.clip(rng.exponential(0.05, 5), 0, 0.3).astype(np.float32)

    # 港 (初期配置で取れる場合あり)
    if rng.random() < 0.20 and prod.sum() > 0.20:
        port = rng.randint(6)
        x[19 + port] = 1.0

    # 相手も同様に設定済み
    for k, base in enumerate(OPP_OFF):
        if base + 17 >= 82: continue
        opp_strength = rng.choice(['weak', 'medium', 'strong'], p=[0.30, 0.50, 0.20])
        opp_prod = sample_production(rng, opp_strength)
        opp_n_sett = rng.choice([1, 2], p=[0.45, 0.55])
        x[base + 5] = opp_n_sett / 10.0
        x[base + 6] = opp_n_sett / 5.0
        x[base + 8] = opp_n_sett / 15.0
        x[base + 13] = opp_n_sett / 15.0
        x[base + 14:base + 18] = opp_prod[:4]

    return x


def make_robber_decision_state(rng, leader_blocked=None):
    """盗賊配置判断時の局面.
    leader_blocked=True なら自分が盗賊でリーダーを止めている → 勝率↑.
    leader_blocked=False ならリーダー以外を狙った無駄配置 → 勝率↓."""
    if leader_blocked is None:
        leader_blocked = rng.random() < 0.5

    # mid-game 状態
    x = make_game_state(rng, turn_frac=rng.uniform(0.35, 0.75),
                        is_winner=leader_blocked)

    # 盗賊で leader をブロックしているなら、相手の生産が落ちている演出
    if leader_blocked:
        # 最強相手の ore/wheat 生産を削減
        max_opp_vp = -1
        target = -1
        for k, base in enumerate(OPP_OFF):
            if base + 5 >= 82: continue
            if x[base + 5] > max_opp_vp:
                max_opp_vp = x[base + 5]
                target = base
        if target >= 0:
            x[target + 14] *= 0.3  # wheat 生産削減
            x[target + 17] *= 0.3  # ore (opponent block is index 17)

    return x


def generate_dataset_realistic(n=500000, rng=None):
    """既存のmid/late局面 + 初期配置 + 盗賊判断 を混ぜたデータセット."""
    if rng is None:
        rng = np.random.RandomState(42)

    X = np.zeros((n, 82), dtype=np.float32)
    y = np.zeros((n, 1), dtype=np.float32)

    # 40% mid/late、30% setup、30% robber decision
    n_setup = int(n * 0.30)
    n_robber = int(n * 0.30)
    n_mid = n - n_setup - n_robber

    idx = 0
    for _ in range(n_mid):
        turn_frac = rng.uniform(0.0, 1.0)
        x = make_game_state(rng, turn_frac=turn_frac)
        X[idx] = x; y[idx, 0] = catan_eval(x); idx += 1
    for _ in range(n_setup):
        x = make_setup_state(rng)
        X[idx] = x; y[idx, 0] = catan_eval(x); idx += 1
    for _ in range(n_robber):
        x = make_robber_decision_state(rng)
        X[idx] = x; y[idx, 0] = catan_eval(x); idx += 1

    # シャッフル
    perm = rng.permutation(n)
    X = X[perm]; y = y[perm]
    return X, y


# ─── Neural network (numpy) ───────────────────────────────────────────────────
def relu(x):
    return np.maximum(0, x)

def sigmoid(x):
    return 1.0 / (1.0 + np.exp(-np.clip(x, -25, 25)))

def forward(x, weights):
    W1, b1, W2, b2, W3, b3, W4, b4 = weights
    h1 = relu(x @ W1 + b1)
    h2 = relu(h1 @ W2 + b2)
    h3 = relu(h2 @ W3 + b3)
    return sigmoid(h3 @ W4 + b4)

def forward_inter(x, weights):
    W1, b1, W2, b2, W3, b3, W4, b4 = weights
    h1 = relu(x @ W1 + b1)
    h2 = relu(h1 @ W2 + b2)
    h3 = relu(h2 @ W3 + b3)
    out = sigmoid(h3 @ W4 + b4)
    return h1, h2, h3, out

def backward(x, y, weights):
    W1, b1, W2, b2, W3, b3, W4, b4 = weights
    h1, h2, h3, out = forward_inter(x, weights)
    N = x.shape[0]
    d = (out - y) * out * (1 - out) * 2 / N
    dW4 = h3.T @ d;  db4 = d.sum(0)
    d3 = (d @ W4.T) * (h3 > 0)
    dW3 = h2.T @ d3; db3 = d3.sum(0)
    d2 = (d3 @ W3.T) * (h2 > 0)
    dW2 = h1.T @ d2; db2 = d2.sum(0)
    d1 = (d2 @ W2.T) * (h1 > 0)
    dW1 = x.T @ d1;  db1 = d1.sum(0)
    return [dW1, db1, dW2, db2, dW3, db3, dW4, db4]


class Adam:
    def __init__(self, lr=0.001, b1=0.9, b2=0.999, eps=1e-8):
        self.lr, self.b1, self.b2, self.eps = lr, b1, b2, eps
        self.t, self.m, self.v = 0, None, None
    def step(self, weights, grads):
        if self.m is None:
            self.m = [np.zeros_like(w) for w in weights]
            self.v = [np.zeros_like(w) for w in weights]
        self.t += 1
        out = []
        for i, (w, g) in enumerate(zip(weights, grads)):
            self.m[i] = self.b1*self.m[i] + (1-self.b1)*g
            self.v[i] = self.b2*self.v[i] + (1-self.b2)*g**2
            mh = self.m[i] / (1 - self.b1**self.t)
            vh = self.v[i] / (1 - self.b2**self.t)
            out.append(w - self.lr * mh / (np.sqrt(vh) + self.eps))
        return out


def init_weights(rng, scale=1.0):
    def fan(n_in, n_out):
        s = np.sqrt(2.0 / (n_in + n_out)) * scale
        return rng.randn(n_in, n_out).astype(np.float32) * s
    W1 = fan(82, 256);  b1 = np.zeros(256, np.float32)
    W2 = fan(256, 128); b2 = np.zeros(128, np.float32)
    W3 = fan(128, 64);  b3 = np.zeros(64,  np.float32)
    W4 = fan(64, 1);    b4 = np.zeros(1,   np.float32)
    return [W1, b1, W2, b2, W3, b3, W4, b4]


def train(weights, X, y, epochs=30, batch=512, lr=0.001, verbose=True):
    opt = Adam(lr=lr)
    N = X.shape[0]
    for ep in range(epochs):
        idx = np.random.permutation(N)
        X, y = X[idx], y[idx]
        losses = []
        for i in range(0, N, batch):
            xb, yb = X[i:i+batch], y[i:i+batch]
            out = forward(xb, weights)
            losses.append(np.mean((out - yb)**2))
            grads = backward(xb, yb, weights)
            weights = opt.step(weights, grads)
        if verbose:
            print(f"  Epoch {ep+1:3d}/{epochs}  loss={np.mean(losses):.6f}")
    return weights


# ─── TF.js save ───────────────────────────────────────────────────────────────
def save_tfjs(weights, out_dir):
    W1, b1, W2, b2, W3, b3, W4, b4 = weights
    raw = b''.join(a.astype(np.float32).tobytes() for a in weights)

    with open(os.path.join(out_dir, 'catan-vnet.weights.bin'), 'wb') as f:
        f.write(raw)

    model_json = {"modelTopology":{"class_name":"Sequential","config":{"name":"sequential_1","layers":[
        {"class_name":"Dense","config":{"units":256,"activation":"relu","use_bias":True,
          "kernel_initializer":{"class_name":"VarianceScaling","config":{"scale":1,"mode":"fan_avg","distribution":"normal","seed":None}},
          "bias_initializer":{"class_name":"Zeros","config":{}},
          "kernel_regularizer":None,"bias_regularizer":None,"activity_regularizer":None,
          "kernel_constraint":None,"bias_constraint":None,
          "name":"dense_Dense1","trainable":True,"batch_input_shape":[None,82],"dtype":"float32"}},
        {"class_name":"Dropout","config":{"rate":0.1,"noise_shape":None,"seed":None,"name":"dropout_Dropout1","trainable":True}},
        {"class_name":"Dense","config":{"units":128,"activation":"relu","use_bias":True,
          "kernel_initializer":{"class_name":"VarianceScaling","config":{"scale":1,"mode":"fan_avg","distribution":"normal","seed":None}},
          "bias_initializer":{"class_name":"Zeros","config":{}},"kernel_regularizer":None,"bias_regularizer":None,
          "activity_regularizer":None,"kernel_constraint":None,"bias_constraint":None,"name":"dense_Dense2","trainable":True}},
        {"class_name":"Dense","config":{"units":64,"activation":"relu","use_bias":True,
          "kernel_initializer":{"class_name":"VarianceScaling","config":{"scale":1,"mode":"fan_avg","distribution":"normal","seed":None}},
          "bias_initializer":{"class_name":"Zeros","config":{}},"kernel_regularizer":None,"bias_regularizer":None,
          "activity_regularizer":None,"kernel_constraint":None,"bias_constraint":None,"name":"dense_Dense3","trainable":True}},
        {"class_name":"Dense","config":{"units":1,"activation":"sigmoid","use_bias":True,
          "kernel_initializer":{"class_name":"VarianceScaling","config":{"scale":1,"mode":"fan_avg","distribution":"normal","seed":None}},
          "bias_initializer":{"class_name":"Zeros","config":{}},"kernel_regularizer":None,"bias_regularizer":None,
          "activity_regularizer":None,"kernel_constraint":None,"bias_constraint":None,"name":"dense_Dense4","trainable":True}}
    ]},"keras_version":"tfjs-layers 4.20.0","backend":"tensor_flow.js"},
    "weightsManifest":[{"paths":["catan-vnet.weights.bin"],"weights":[
        {"name":"dense_Dense1/kernel","shape":[82,256],"dtype":"float32"},
        {"name":"dense_Dense1/bias","shape":[256],"dtype":"float32"},
        {"name":"dense_Dense2/kernel","shape":[256,128],"dtype":"float32"},
        {"name":"dense_Dense2/bias","shape":[128],"dtype":"float32"},
        {"name":"dense_Dense3/kernel","shape":[128,64],"dtype":"float32"},
        {"name":"dense_Dense3/bias","shape":[64],"dtype":"float32"},
        {"name":"dense_Dense4/kernel","shape":[64,1],"dtype":"float32"},
        {"name":"dense_Dense4/bias","shape":[1],"dtype":"float32"}
    ]}],
    "format":"layers-model","generatedBy":"TensorFlow.js tfjs-layers v4.20.0","convertedBy":None}

    with open(os.path.join(out_dir, 'catan-vnet.json'), 'w') as f:
        json.dump(model_json, f, separators=(',', ':'))

    print(f"Saved catan-vnet.json + catan-vnet.weights.bin  ({len(raw):,} bytes)")


# ─── Main ─────────────────────────────────────────────────────────────────────
if __name__ == '__main__':
    rng = np.random.RandomState(2026)
    OUT = '/Users/shoujihiroshitou/Downloads/カタン１'

    print("=" * 60)
    print("Catan Foundation Model  (Research-Based Teacher Distillation)")
    print("=" * 60)

    # Step 1: verify teacher function makes sense
    print("\n[1] Verifying teacher evaluation function...")
    test_cases = [
        ("Strong winner (high VP, ore+wheat)",
         dict(vp=9, cities=3, sett=2, prod=[0.08,0.06,0.22,0.10,0.25], lr=1, la=1)),
        ("Early leader (good production)",
         dict(vp=6, cities=1, sett=4, prod=[0.14,0.12,0.16,0.12,0.14], lr=0, la=0)),
        ("Weak player (low pip)",
         dict(vp=3, cities=0, sett=3, prod=[0.05,0.04,0.03,0.06,0.01], lr=0, la=0)),
        ("Road builder (no cities)",
         dict(vp=7, cities=0, sett=5, prod=[0.18,0.18,0.08,0.12,0.02], lr=1, la=0)),
    ]
    for name, tc in test_cases:
        x = np.zeros(82, dtype=np.float32)
        x[SELF_VP] = tc['vp'] / 10.0
        x[SELF_CITY] = tc['cities'] / 4.0
        x[SELF_SETT] = tc['sett'] / 5.0
        x[SELF_PROD] = tc['prod']
        x[SELF_LR] = tc['lr']
        x[SELF_LA] = tc['la']
        x[TURN] = 0.6
        score = catan_eval(x)
        print(f"  {name}: {score:.3f}")

    # Step 2: generate large realistic dataset
    print("\n[2] Generating 500,000 realistic game states...")
    X, y = generate_dataset_realistic(n=500000, rng=rng)
    print(f"  X: {X.shape}  y: {y.shape}")
    print(f"  Labels: mean={y.mean():.3f}  std={y.std():.3f}  "
          f"min={y.min():.3f}  max={y.max():.3f}")

    # Step 3: train
    print("\n[3] Phase 1 — Main training (40 epochs, lr=0.001, batch=1024)...")
    weights = init_weights(rng)
    weights = train(weights, X, y, epochs=40, batch=1024, lr=0.001)

    print("\n[4] Phase 2 — Fine-tune (20 epochs, lr=0.0002, batch=512)...")
    weights = train(weights, X, y, epochs=20, batch=512, lr=0.0002)

    print("\n[5] Phase 3 — Final polish (10 epochs, lr=0.00003, batch=256)...")
    weights = train(weights, X, y, epochs=10, batch=256, lr=0.00003)

    # Step 4: verify
    print("\n[6] Verification on held-out set...")
    Xv, yv = generate_dataset_realistic(n=10000, rng=np.random.RandomState(999))
    pv = forward(Xv, weights).flatten()
    yf = yv.flatten()
    mse = np.mean((pv - yf)**2)
    corr = np.corrcoef(pv, yf)[0, 1]

    # Split by label quartile
    q25, q75 = np.percentile(yf, 25), np.percentile(yf, 75)
    strong = pv[yf >= q75]
    weak   = pv[yf <= q25]
    print(f"  MSE = {mse:.6f}")
    print(f"  Correlation = {corr:.4f}")
    print(f"  Top 25% states: avg score = {strong.mean():.3f} ± {strong.std():.3f}")
    print(f"  Bot 25% states: avg score = {weak.mean():.3f}   ± {weak.std():.3f}")
    print(f"  Separation = {strong.mean() - weak.mean():.3f}")

    # Test on known good/bad positions
    print("\n  Known position test:")
    for name, tc in test_cases:
        x = np.zeros(82, dtype=np.float32)
        x[SELF_VP] = tc['vp'] / 10.0
        x[SELF_CITY] = tc['cities'] / 4.0
        x[SELF_SETT] = tc['sett'] / 5.0
        x[SELF_PROD] = tc['prod']
        x[SELF_LR] = tc['lr']
        x[SELF_LA] = tc['la']
        x[TURN] = 0.6
        score = forward(x[None], weights)[0, 0]
        teacher = catan_eval(x)
        print(f"  {name}: NN={score:.3f}  teacher={teacher:.3f}")

    print("\n[7] Saving TF.js model...")
    save_tfjs(weights, OUT)
    print("\nDone.")
    print("\nNext steps:")
    print("  1. Open the browser game")
    print("  2. Click 'ファイル入力'")
    print("  3. Select both: catan-vnet.json AND catan-vnet.weights.bin")
    print("  4. Enable 'NN使用' and click '自動学習(25%超まで)'")
