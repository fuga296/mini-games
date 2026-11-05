# 設計

## 目標

1. 普通の人狼を、遊べる形で完成させる。
2. 変則人狼（ワンナイト、第二の目的、能力カードの消費、目立ちたがり人狼、数人狼、老人人狼、パワーワード人狼など）を、**エンジンを変えずに** ルールセットの追加だけで載せられる。
3. モバイルアプリへの移植と、各自の端末で遊ぶ形（通信）への拡張ができる。

## 層の分け方

```
┌────────────── 画面（ブラウザ専用） ──────────────┐
│ index.html / ui/app.js                            │  ← アプリに移すときは書き直す
│ ui/text-ja.js（文言・台本。DOM 非依存）           │  ← そのまま使える
└───────────────▲──────────────────────────────────┘
                │ view(誰の目線か) / dispatch(誰が, 何を)
┌───────────────┴──────── core/session.js ─────────┐
│ 操作者の権限チェック・変化の通知                   │  ← 通信版はここを差し替える
└───────────────▲──────────────────────────────────┘
┌───────────────┴──────── core/engine.js ──────────┐
│ 状態(JSON)・段階の進行・行動の解決順・投票の集計   │
│ 勝利判定・見え方(view)                             │  ← ルールの中身は持たない
└───────────────▲──────────────────────────────────┘
┌───────────────┴──────── rules/*.js ──────────────┐
│ 陣営・役職・行動・段階・勝利条件・設定・配役       │  ← 変則人狼はここに足す
└──────────────────────────────────────────────────┘
```

- `core/` と `rules/` は `window`、`document`、`localStorage` に触れない。Node のテストでそのまま動く。
- 乱数は種つき（`core/rng.js`）で、その状態は state に入っている。同じ state に同じ命令を与えれば、必ず同じ結果になる（再現、リプレイ、通信の同期に使える）。

## 中核の概念

| 概念 | どこに | 形 |
|---|---|---|
| 状態 | `state` | ただの JSON。`players[]`（`roleId`, `team`, `alive`, `counters`, `memory`）、`phase`、`day`、`log[]`、`actions`、`votes`、`extra`、`result`、`rng` |
| 陣営 | `ruleset.teams` | `{ id, name }` |
| 役職 | `ruleset.roles` | `{ id, name, team, countAs, divine, medium, revealGroup, actions[], attackImmune, ... }`。エンジンが読むのは `team` と `actions` だけで、残りの属性はルールセットの関数が読む |
| 行動 | `ruleset.actions` | `{ phases[], priority, available(), targets(), instant(), resolve(), aggregate, changeable, allowNoTarget }` |
| 段階 | `ruleset.phases` | `{ label, enter(), acks(), acceptsActions, vote:{voters(),candidates()}, resolve(), checkWin, next() }` |
| 勝利条件 | `ruleset.winConditions` | `{ kind:'base'｜'override'｜'individual', priority, check() }` |
| 見え方 | `log[].visibleTo` と `ruleset.knowledge()` | 記録ごとに `'all'`／`'gm'`／`[playerId...]`。役職の見え方は `knowledge(ctx, me)` が返す |
| 追加の命令 | `ruleset.commands` | `dispatch` が知らない `type` の命令をここで受ける |

### 進行

`dispatch(state, ruleset, command)` は新しい state を返す純粋な関数で、元の state は書き換えない。

- `ack`：確認（役職の確認など、`phase.acks()` に入っている人）
- `act`：行動を出す（`availableActions` で許されたものだけ）。`instant` があれば、その場で本人に結果を出す（占いの結果をすぐ見せるため）
- `vote`：投票（`phase.vote` がある段階だけ）
- `advance`：段階を終える。`resolve()` → `checkWin` → `next()` → 次の段階の `enter()` の順に呼ぶ。入力していない人がいれば `force` が必要
- その他：`ruleset.commands[type]`

### 夜の行動の解決順

`engine.resolveActions(ctx, scratch)` は次の順に動く。

1. 出された行動を集める。
2. `aggregate` を持つ行動は、複数人の選択を1つにまとめる（人狼の襲撃は最多票。同数のときは設定どおり）。
3. `priority` の小さい順に並べる（同じ priority なら席順）。
4. 各行動の `resolve(ctx, inst, scratch)` を呼ぶ。`scratch` は解決中の一時メモで、標準ルールでは `{ protected, deaths }`。

標準ルールでは 護衛(10) → 占い(20) → 襲撃(30) の順に解決し、そのあと `deaths` をまとめて適用する。
占われた妖狐の呪殺も、襲撃と同じ夜に起きる。

### 勝利判定

`checkWin` は `priority` の順に、3種類の勝利条件を評価する。

1. `base`：最初に成立したものを暫定の結果にする（村人の勝ち、人狼の勝ち）。どれも成立しなければゲームを続ける。
2. `override`：暫定の結果があれば、それを上書きできる（妖狐の勝ち）。
3. `individual`：陣営の勝敗とは別に、個人の勝者を足す（第二の目的など）。

勝者は「陣営が勝った人」と「個人で勝った人」を合わせた集合になる。陣営は `player.team`（個人の上書き）があればそれを使い、なければ役職の `team` を使う。

### 誰に何が見えるか

`view(state, ruleset, viewerId)` だけが「見せてよい情報」を作る。画面は state を直接読まない。

- `viewerId` は プレイヤーID／`'gm'`（すべて）／`'public'`（全員に見せてよいものだけ）のどれか。
- 記録は `visibleTo` で絞る。他人の役職は、本人のもの、`knowledge()` が返すもの（人狼の仲間など）、死亡時に公開する設定のときのもの、終了後のものだけが見える。
- 誰がまだ入力していないかは、司会にしか返さない（公開すると能力者がばれるため）。

## 遊び方と通信の差し込み口

画面が使うのは `session` の4つの関数だけ。

```js
session.view(viewerId)          // 見てよい情報
session.dispatch(actor, cmd)    // actor = {kind:'player',playerId} | {kind:'gm'} | {kind:'host'}
session.subscribe(fn)           // 変化の通知
session.snapshot()              // 保存用 JSON
```

- **スマホ1台を回す**：`LocalSession`。端末そのものは `host`（段階を進めるだけ）として操作し、秘密の操作は持っている本人の `player` として送る。
- **司会役の支援**：`LocalSession`。司会が `gm` として、全員の分を入力する。
- **各自の端末（未実装）**：同じインターフェースの `RemoteSession` を作る。
  - 親機（またはサーバー）が `LocalSession` を持つ。子機の `dispatch` を受けて `authorize` を通し、変化があれば各子機に `view(その子機のプレイヤーID)` を送る。
  - 子機は、受け取った view を描画するだけにする。state 全体は親機の外に出さないので、通信を覗いても他人の役職は分からない。
  - 乱数は親機の中だけで回すので、同期の問題は起きない。
  - 通信路（WebSocket、WebRTC、Bluetooth など）は `RemoteSession` の中に閉じ込める。画面のコードは変えない。

## 変則人狼の載せ方

変則人狼は `standard.extend(patch)` で標準ルールを上書きして作る。
`roles`、`actions`、`phases` などは1段深くマージし、`winConditions` は関数（元の配列 → 新しい配列）で差し替える。

以下の3例が、エンジンを変えずに載ることを `tests/plugpoints.test.js` で確かめている（遊べる変則ではなく、差し込み口を検証するための最小のスケッチ）。

### 例1：ワンナイト人狼

夜1回、昼1回、投票1回で決着する。場札があり、怪盗が役職を入れ替える。

| 必要なこと | 使う差し込み口 |
|---|---|
| 人数＋2枚を配り、余りを場札にする | `setup(ctx, opts)` で `state.extra.center` に置く |
| 夜→昼→投票→終了の1周だけにする | `phases` を差し替える。`vote.next()` が `'end'` を返す |
| 占い師は「交換前の役職」を見て、怪盗は交換後の役職を知る | 占い `priority:20` → 交換 `priority:50`。交換は `resolve` で `roleId` を入れ替え、本人だけに見える記録を出す |
| 処刑された人の中に人狼がいれば村の勝ち | `winConditions` を差し替え、投票の段階だけ `checkWin` |
| 勝敗は交換後の役職で判定 | `ctx.team(p)` は今の `roleId` を見るので、そのまま正しくなる |

```js
const oneNight = standard.extend({
  roles:   { thief: { team:'village', actions:['swap'], ... } },
  actions: { swap: { phases:['night'], priority:50, targets, resolve(ctx, inst){ /* roleId を入れ替え */ } } },
  phases:  { night:{...}, day:{ next:()=>'vote' }, vote:{ checkWin:true, vote:{...}, resolve, next:()=>'end' } },
  winConditions: () => [ /* 処刑者に人狼 → village / それ以外 → werewolf */ ],
  setup(ctx, opts) { /* 配って余りを extra.center へ */ },
});
```

場札を占う、場札と交換する、といった行動は、対象として場札の ID を返す `targets` を書けば追加できる。そのときは `engine.availableActions` の対象をプレイヤーに限らないよう、対象の型を広げる（下の「既知の限界」）。

### 例2：第二の目的人狼

陣営の勝敗とは別に、各自が秘密の個人目的を持つ。

| 必要なこと | 使う差し込み口 |
|---|---|
| 目的を各自に配る | `setup` で標準の `setup` を呼んだあと、`player.memory.objective` に入れる |
| 目的は本人にだけ見せる | `ctx.emit('objectiveAssigned', ..., [p.id])` |
| 陣営の勝敗とは別に、個人の勝利を足す | `winConditions` に `kind:'individual'` を1つ足す |

```js
const secondGoal = standard.extend({
  setup(ctx, opts) { standard.setup(ctx, opts); /* 目的を配り、本人だけに見える記録を出す */ },
  winConditions: (base) => base.concat([{ kind:'individual', check: ctx => /* 達成した人の ID */ }]),
});
```

### 例3：能力をカードで消費する制

能力を使うたびにカードを1枚消費し、無くなると使えない。カードを他人に渡すこともできる。

| 必要なこと | 使う差し込み口 |
|---|---|
| 各自のカード枚数 | `player.counters.cards`（汎用カウンタ）。view では本人と司会にだけ見える |
| 枚数が0なら使えない | 行動の `available(ctx, me)` を包む |
| 使ったら減らす | 行動の `resolve` を包む（妨害されても消費するかどうかは、包み方で選べる） |
| カードを渡す、という新しい操作 | `commands.giveCard(ctx, cmd)` |
| 初期の枚数を設定にする | `defaultConfig.startingCards` |

```js
const withCost = (a) => ({ ...a,
  available: (ctx, me) => me.counters.cards > 0 && a.available(ctx, me),
  resolve:   (ctx, inst, s) => { /* 枚数を1減らす */ a.resolve(ctx, inst, s); } });
const cards = standard.extend({
  actions:  { divine: withCost(standard.actions.divine), guard: withCost(standard.actions.guard) },
  commands: { giveCard(ctx, cmd) { /* 枚数を移す */ } },
});
```

### そのほかの変則の見通し

| 変則 | 主に使う差し込み口 |
|---|---|
| 目立ちたがり人狼 | 役職の属性と、昼の段階の `resolve`（発言を数える命令を `commands` に足す） |
| 数人狼 | `knowledge()` で見える情報を変え、`setup` で数字を配る |
| 老人人狼 | `counters`（寿命）と、夜の段階の `enter` で日数に応じて死亡させる |
| パワーワード人狼 | `setup` で秘密の言葉を `memory` に配り、`commands` で「言った」を記録し、`individual` の勝利条件で判定する |

## 既知の限界（次に手を入れるところ）

- 行動の対象はプレイヤーID だけを想定している。場札や「2人を選ぶ」行動には、`targets` が `{ kind, id }` を返せるように広げる（`act` の命令は `targetId` に配列や対象オブジェクトも許すようにする）。
- 1つの段階に、同じ人が同じ行動を複数回出すことはできない（`actions[playerId][actionId]` が1つだけのため）。
- 文言は日本語だけ。役職名はルールセットの中にあり、記録の文章は `ui/text-ja.js` にある。多言語にするときは、役職名も文言側の辞書へ移す。
