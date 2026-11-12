# magpie-pareto 设计

这是 magpie（yetone/magpie）的一个社区插件。它在 magpie 里画一张散点图：横轴是**你能拿到的渠道价**，纵轴是**模型能力分**。用途是按任务给路由组挑模型和 effort。

界面只做中文。设计已经和用户逐条定过，本文是唯一的真相源。实现时如果发现和事实冲突，**先停下来汇报，不要自己改设计**。

上游源码参考 `/tmp/magpie-latest`（没有就 `git clone --depth 1 https://github.com/yetone/magpie /tmp/magpie-latest`）。插件骨架照搬兄弟项目 `~/gitRepos/github.com/broven/magpie-intent-lab`：先读它的 `DESIGN.md`、`index.js`、`page/`、`src/server.ts`、`scripts/e2e.ts`、`scripts/ui-shot.ts`。

## 不做（v1）

- **不做 Pareto 前沿计算**。图画出来，最优解由用户自己看。
- 不按 effort 拆点。以后要展示各档 effort 的差别，应该换成「每个任务的成本」作横轴（用 real-api-pricing 的 `mean_cost_usd_per_task`，或 CursorBench 这类带 token 消耗或成本的榜单），而不是单 token 价。
- 不做复合分，不做用户自测的能力分，不做 magpie 面板嵌入，不做英文界面。
- 不画用户 magpie 里调不到的模型。

## 形态

- `package.json`
  - `main: index.js`，keywords 含 `magpie-plugin`
  - `magpie.page {title:"Pareto", titles:{zh:"性价比图"}, file:"page/index.html", icon:"page/icon.svg", service:{port:3498, option:"port"}}`
  - `magpie.options {port:3498}`
- `index.js` 不 await 就启动 `Bun.serve`，端口被占就重试，用全局变量防止重复启动，写法和 intent-lab 一样。
- `page/index.html` 加载 `_magpie/bridge.js`，就绪后把自己的 frame 导航到 `magpie.service || http://127.0.0.1:<port>/`。禁止内联 `<script>`：页面的 CSP 只放行插件目录里的脚本文件。
- service 提供整个 UI（原生 HTML+JS + 手写 SVG，不需要构建，不引图表库）。
  - 安全：每个进程生成一个口令（随 `/` 的 HTML 下发，API 要求带 header）+ Host 校验 + `Access-Control-Allow-Origin: null`。做法和 intent-lab 一样。
- 用户状态存在 `~/.config/magpie/pareto/state.json`，是这些数据的唯一存放处：
  - 订阅输入
  - 别名覆盖
  - 手动分数
  - 存疑标记
  - 系列修正
  - LLM 匹配用哪个模型
  - LLM 匹配结果（含「已确认 / AI 猜测」状态）
  - 隐藏的渠道（`hiddenProviders`）
  - 隐藏的模型（`hiddenModels`）
  - 额度倍率（`quotaMultipliers`，键 `provider/model`，用于免费列内的横向排位）
- 缓存目录：`~/.config/magpie/pareto/cache/`。
- 所有外部路径和 URL 都能用环境变量覆盖，供 E2E 用：`PARETO_PORT`、`MAGPIE_ADDR`、`PARETO_CONFIG_DIR`（默认 `~/.config/magpie`）、`PARETO_MODELS_JSON`、`PARETO_RAP_URL`、`PARETO_EPOCH_URL`、`PARETO_STATE_DIR`、`PARETO_MAGPIE_ENV`（JSON，写回时传给 magpie CLI 的环境，同 intent-lab）。
- magpie 可执行文件的查找顺序：`options.magpieBin` → PATH 里的 `magpie` → `/Applications/magpie.app/Contents/MacOS/magpie`。

## 数据源

1. **渠道生效价**：`GET http://$MAGPIE_ADDR/v1/models`，loopback 不需要 key。
   - 只取 `provider/model` 形式的条目，跳过 `group/*` 和 `auto/*`。
   - `pricing{prompt,completion,input_cache_read,input_cache_write}` 的单位是 USD/token 字符串，乘以 1e6 换成 USD/MTok。
   - `reasoning_levels` 是这个渠道上该模型支持的 effort。
   - 这个价格已经叠加了用户的 `modelPrices`、插件价和峰谷价，它就是真相源。不要自己去读 `settings.json` 重算。
   - 免费的判定：四个价格全为 0 或缺失，并且 `/v1/models` 或插件 provider 缓存（`plugin-providers.json` 的 `free`）标了免费。只要四价全为 0，就画进免费列。
2. **官方价**：models.dev 目录。路径取 `PARETO_MODELS_JSON`，没设就依次找 `~/.cache/magpie/models.json`、`~/.cache/opencode/models.json`。
   - 按厂商 provider 找同 id 的模型（deepseek、zhipuai、moonshotai、openai、anthropic、alibaba、xiaomi、minimax、google、xai……；id 规范化方式同下文的匹配规则）。
   - `cost{input,output,cache_read,cache_write}` 的单位是 USD/MTok。只用于订阅计算器和系列判断（`release_date` / `family`），**不画到图上**。
   - 全 0 价格的目录条目不是官方价，必须排除（渠道的 `-free` 条目规范化后会撞到同 id）。
3. **token 结构（负载画像）**：`$PARETO_CONFIG_DIR/usage.jsonl`，只用最近 30 天。
   - 字段：`t, agent, provider, model, req, in, out, cache_read, cache_write, cache_write_1h`。
   - **`in` 是否包含 cache 部分，必须照 `internal/usage/usage.go` 的 `CostAt` 语义来处理**，不能靠猜。
   - 画像有三种：全部 / 某个路由组（`req == "group/<id>"`）/ 某个 agent。
   - 画像 = 四类 token 的占比向量。**同一张图里，所有点都用同一个画像。**
   - 也可以切换成以下几种固定口径，此时不看账本：
     - 「3:1（input:output，不计 cache）」
     - 「只看 input」
     - 「只看 output」
4. **路由组**：`$PARETO_CONFIG_DIR/providers.json` 的 `groups[]`。成员的格式见源码 `internal/provider/group.go`，跳过 hidden 的空组。
5. **能力分 A：real-api-pricing**（MIT）
   - 地址：`PARETO_RAP_URL`，默认 `https://realapipricing.com/data/site.json`，大约 2.7MB，带 ETag。
   - 8 个榜单：aa_intelligence_index、aa_coding_agent_index、arena_code、arena_agent_mode、open_design_arena、terminal_bench_4、aa_terminal_bench_4、deepswe_1_1。每个榜单都有 `snapshot`。
   - configurations 的每一行是一个 model（裸 slug，例如 `glm-5.3`）× reasoning_effort × agent_harness 的配置。
   - 每个（model, effort, board）**取各 harness 里的最高分**，hover 时显示 harness 名。
   - 动手前先拉一份实际的 site.json 看清结构。
6. **能力分 B：Epoch AI**（CC-BY）
   - 地址：`PARETO_EPOCH_URL`，默认 `https://epoch.ai/data/benchmark_data.zip`。
   - 只用两个文件：
     - `epoch_capabilities_index/eci_scores.csv`：作为「Epoch ECI」榜单，没有 effort 维度
     - `swe_bench_verified.csv`：作为「SWE-bench Verified (Epoch)」榜单。`Model version` 的格式是 `<slug>_<effort>`，比如 `glm-5.2_max`；`_unknown` 视为无 effort
7. **套餐额度**（订阅计算器预填用）：来自 real-api-pricing 的同一份 site.json，或者它的 adopted 数据。
   - 用到的字段：`plan_id`、价格 `price_usd`、`served_model`、`monthly_tokens`，标准负载下的官方混合价 `list_blended_usd_per_mtok`，以及 `confidence`。
   - 忙时、中间、闲时这类场景是不同的 `plan_id` 后缀，默认选忙时。

数据刷新：打开页面时，如果缓存超过 24 小时，就在后台刷新。失败时继续用旧缓存，页面上显示缓存日期。另有一个手动刷新按钮。

## 计算

### 横轴：价格

对每个（渠道, 模型），合成价 = Σ 画像占比ᵢ × 价格ᵢ。

- 渠道缺 cache_read 或 cache_write 的价格时，按 input 价计算。
- 2026-11-12 用户改定：图上只画真实渠道的点，不画官方价参照。
- 横轴默认用对数刻度，可以切到线性。
- 免费点放在最左侧单独的「免费」列，不在对数轴上。
  - 送免费额度、按倍率消耗额度的渠道（workbuddy 这类），在 magpie 里通常定价为 0，因此落进免费列。倍率存在 state 的 `quotaMultipliers`（键 `provider/model`），可以在点操作面板里填写或清空。
  - 免费列内部是一个线性小轴「额度倍率」：0x 在最左，列内最大倍率在最右（最大值至少按 1x 计，避免只有 0x 时挤成一团）。没有倍率的免费点放在列内最右侧，tooltip 标「倍率未知」。
  - 免费列宽度约为绘图区的 10%，列底部标 `0x` 和列内最大倍率；跨渠道连线连到点在免费列里的实际位置。

### 纵轴：能力

当前选中榜单的原始分（百分比或 Elo），轴标题注明榜单名和快照日期。

- 渠道里的模型默认和官方同分。
- 用户可以给某个（渠道, 模型）标「存疑」，可选再给一个系数（score × 系数），这个点用虚线描边。

### 点与连线

- 每个点 =（渠道 × 模型），**不按 effort 拆点**。横轴是单 token 价，同一模型的各档 effort 价格完全相同，拆开画只会叠成一列，没有信息量（2026-11-12 用户改定）。
  - 分数 = 当前榜单上这个模型在**该渠道 `reasoning_levels` 支持的 effort** 中的最高分（各 harness 取最高）。渠道没有声明 `reasoning_levels`，或者榜单的分数没有 effort 维度，就取这个模型在榜单上的最高分。
  - tooltip 里写明取的是哪个 effort 和 harness。
- **同一个模型用同一种颜色。** 同一模型在不同渠道上的点，用实线横线连起来。
- **图上只画真实渠道的点，不画官方价参照**（2026-11-12 用户改定）。
- 有价格但当前榜单没有分数的模型，放进图底部的「无分数」带，按价格排开。点一下可以给当前榜单手动打分，存进 state，手动分画成实心点并加标注。
- 图表上方有一排渠道 chip，列出 `/v1/models` 里所有有价格的渠道（显示渠道名和模型数）。点击切换显示/隐藏。默认全部显示，状态存在 state 的 `hiddenProviders`。
  - 隐藏的渠道：它的点、无分数带条目、跨渠道连线都不画；坐标轴范围只按可见点算。
  - `/api/chart` 仍返回完整渠道列表（含隐藏的）供 chip 渲染。
- 模型也可以隐藏。隐藏粒度是 magpie 模型 id（`provider/model` 里的 model 部分，原样字符串），对所有渠道生效。入口有两处：「名称匹配」表里每行的「隐藏」按钮，以及点/无分数条目的操作面板里的「隐藏这个模型」。
  - 隐藏的模型：它的点、无分数带条目、跨渠道连线、`unmatched` 列表条目都不出现；坐标轴范围只按可见点算。渠道 chip 的模型数不变（仍是该渠道全部有价模型数）。
  - `/api/chart` 返回 `hiddenModels[]`（`{model, providers[]}`）供「已隐藏的模型」列表恢复用。状态存在 state 的 `hiddenModels`。
- 点旁标签是 `渠道/模型`（magpie 风格，例如 `wokey/deepseek-v4.1-flash`）。标签贪心放置：依次尝试点的右、左、上、下；和已放置标签的 bbox 冲突就试下一个位置，都冲突或超出绘图区就不画这个标签（tooltip 里仍能看到）。
- 路由组只在 hover tooltip 里列出，可以按组筛选。
- hover 一个点时，它所属模型的整组高亮，其余变暗。tooltip 显示：
  - 渠道、模型、effort、harness
  - 四项单价和合成价
  - 分数和来源
  - 匹配方式（人工 / 模糊 / AI 猜测）
  - 路由组

### 系列与「只画最新一代」

- **系列键 = models.dev 的 `family` + 从模型 id 中取出的档位后缀**。后缀包括 flash、flashx、pro、max、plus、air、mini、nano、highspeed、ultraspeed、omni、vision 或 v，以及参数规模（如 35b-a3b）。
  - 原因：models.dev 的 family 太粗，qwen、mimo、kimi-k3、minimax 都把不同档位放进了同一个 family。
- 用户可以在 state 里修正某个模型的系列归属。
- 最新一代 = 在用户**所有渠道**可调用的模型里，同系列中 `release_date` 最新的那一个。
- 旧一代默认隐藏。**例外**：如果某个渠道上旧一代的合成价，比同系列最新一代在任何渠道上的最低合成价还便宜，就保留显示，并标成「旧代」。另有一个「显示全部旧代」开关。

### 名称匹配（magpie 模型 id → 榜单模型 / effort）

按优先级依次尝试，命中即停：

1. **人工映射**：先看 state 里的用户覆盖，再看仓库内置的 `data/aliases.json`。内置表只收自动匹配会出错的条目。
2. **规范化后精确相等**：
   - 去掉 provider 前缀
   - 转小写
   - `.` 和 `-` 统一
   - 去掉日期后缀（`-1017`、`-20260917` 等）
   - 去掉 `-preview` 之类的发布标记，但要保留 pro、flash 这类档位词
   - 规范化后有多个候选的，视为歧义，交给下一层处理
3. **LLM**：调用用户在设置里选的 magpie 模型或组（`POST $MAGPIE_ADDR/v1/chat/completions`）。**没有默认模型，用户没选就跳过这一层。**
   - 只对前两层没命中的条目调用，结果缓存在 state。
   - 结果标成「AI 猜测」：照常画进图，用虚线描边。用户可以一键确认（写进用户覆盖）或驳回。

**「名称匹配」面板**：
- 主体是一张表，列出当前榜单下没有匹配到任何榜单模型的 magpie 模型（match 为 null；按模型 id 去重，注明它出现在哪些渠道）。每行一个输入框，带当前榜单全部模型名的 datalist 自动补全；保存后调 `/api/state/alias` 写人工映射并刷新图。
- 另列「已有人工映射」，显示 `原名 → 榜单名`，每条可删除（`boardModel` 为空即删除）。
- 已匹配但当前榜单没分的模型仍在「无分数」带里，不在这张表里。
- 原 LLM 输入框挪到面板下方，标题「可选：让 LLM 自动猜未匹配的模型」，placeholder 说明填 magpie 里的模型或路由组（如 `group/light`）。AI 猜测的确认/驳回列表保留。

effort 名对齐也走这套流程。magpie 的 effort 有 low、medium、high、xhigh、max；Epoch 用 `_max`、`_high` 等后缀；RAP 用 `reasoning_effort` 字段。内置一张显式的对照表。

### 订阅计算器（结果写回 magpie）

订阅输入存在 state 里，按渠道（magpie provider）分别保存。有四种额度口径：

1. **等值美元**：每月的额度相当于多少美元的官方价用量。
2. **token 额度**：每月多少 token，按当前画像下的官方合成价换算成等值美元。
3. **每时间窗请求数**：每 W 小时 N 次。
   - 每月请求数 = N × (28×24/W)。
   - 再乘以这个渠道在账本里的平均每次请求 token 结构，按官方价换算成等值美元。
   - 账本里没有这个渠道的数据就报错，提示改用其它口径。
4. **积分 × 每模型倍率**：输入「1× 倍率下每月额度的等值美元」，以及每个模型的倍率。

费用可以填 USD，也可以填 CNY。填 CNY 时必须同时填汇率，插件不预设汇率。

**预填**：可以选「这个渠道对应 real-api-pricing 的哪个套餐」（按 plan_id 前缀列出候选，例如 `chatgpt_pro_20x`）。
- 选定后填入月费，以及每个模型的额度：月额度（等值美元）= `monthly_tokens/1e6 × list_blended_usd_per_mtok`。
- 同一套餐下不同模型的额度是**互斥的备选**，不能相加，所以每个模型单独计算折扣率。
- 场景默认取忙时，可以改。
- 上游额度数据有变化时，在页面上提示「额度数据有更新」。

**计算**：
- 折扣率 r = 月费(USD) ÷ 额度等值美元。积分口径下，再乘以该模型的倍率。
- 渠道里每个模型的四项价格 = 官方价 × r。

**写回**：只能手动触发，点「重算并写回」。
- 先列出每个（provider/model）新旧四项价格的 diff，用户确认后，用 `magpie model price` 逐条写入。CLI 的参数格式以 `--help` 为准。
- 写入后重新读取 `/v1/models` 核对结果。

### 写回路由组

点上的菜单项「设为路由组成员」：
- 先选组，再选「替换为唯一成员」或「追加到末尾」。
- 列出 `magpie group set <id> models=…` 的命令和成员 diff，确认后执行，然后用 `magpie group <id>` 读回核对。

## service API（JSON）

- `GET /api/chart?board=&profile=&scale=`：返回计算好的全部绘图数据：
  - `points[]`：`{provider, model, series, effort, price{input,output,cache_read,cache_write,blended}, free, score, scoreSource, harness, match:{kind:"manual"|"fuzzy"|"llm", confirmed}, suspect, oldGen, groups[], quotaMultiplier}`
  - `noScore[]` 同样带 `quotaMultiplier`（未设置时为 `null`）
  - `noScore[]`
  - `providers[]`：`{id, name, modelCount, hidden}`，包含所有有价格的渠道（含隐藏的）
  - `boardModels[]`：当前榜单的全部模型名（名称匹配的 datalist 用）
  - `unmatched[]`：`{model, providers[]}`，当前榜单下 match 为 null 的 magpie 模型
  - `hiddenModels[]`：`{model, providers[]}`，已隐藏的模型及其出现的渠道，供恢复用
  - `aliases[]`：`{model, boardModel}`，state 里已有人工映射
  - `boards[]`（含 snapshot 日期）
  - `profiles[]`
  - `cacheDates`
- `POST /api/refresh`：手动刷新数据源。
- `GET/POST /api/state/*`：读写用户状态，包括别名覆盖、手动分数、存疑标记、系列修正、LLM 模型、确认或驳回 AI 猜测、`hiddenProviders`、`hiddenModels`。
  - `POST /api/state/alias`：body `{model, boardModel}`；`boardModel` 为空表示删除这条人工映射。
  - `POST /api/state/providers`：body `{provider, hidden}`，切换渠道显示/隐藏。
  - `POST /api/state/hidden-model`：body `{model, hidden}`，切换模型显示/隐藏。`model` 是 magpie 模型 id（`provider/model` 里的 model 部分），对所有渠道生效。
  - `POST /api/state/quota-multiplier`：body `{provider, model, multiplier}`，设置额度倍率；`multiplier` 为空或 `null` 表示删除。必须是 >= 0 的有限数，否则返回 400。
- `POST /api/subscription/preview`：返回价格 diff。
- `POST /api/subscription/apply`：执行写回，传 `dryRun` 时只返回命令。
- `POST /api/group/preview`、`POST /api/group/apply`：同上，对象是路由组。

**UI 只渲染 `/api/chart` 的结果。所有计算都在 service 里完成**，这样 E2E 才能直接对数据做断言。

## 页面底部署名

需要列出的数据源：
- real-api-pricing（MIT）
- Artificial Analysis（AA 系列榜单必须署名）
- Epoch AI（CC-BY 4.0）
- models.dev

每个数据源都写出快照日期和缓存日期。

## 验收（E2E）

- `bun run e2e`：
  - 用 `fixtures/` 里的测试数据启动 service，包括：一个假的 `/v1/models` 服务、providers.json、usage.jsonl、models.json 片段、site.json 片段、Epoch 的 zip 片段。
  - 逐条断言并输出 `PASS <label>`，最后一行输出 `E2E PASS`，并在 `artifacts/` 下写一份 JSON 报告。至少要覆盖：
    1. 只出现 `/v1/models` 里的 provider/model，group 和 auto 被跳过
    2. 合成价：对一个手算过的点，在「全部」「某个组」「3:1」三种画像下分别核对，误差小于 1e-9
    3. cache 价缺失时按 input 价计算
    4. 免费点进免费列
    5. 每个（渠道, 模型）只有一个点；同一模型多渠道的点有横线连接；分数取渠道支持的 effort 里的最高分（构造一个渠道不支持 max 的用例，它的分数应该落在 high 档）
    6. 图上没有官方/参照点（`/api/chart` 不再有 `officialPoints`）
    6b. 隐藏一个渠道后，可见点、无分数条目和跨渠道连线里都没有该渠道；渠道列表里仍有它且标为隐藏；重新打开恢复
    6c. 未匹配列表：fixture 里的 `hy4free` 出现在 `unmatched`；调 alias API 映射到榜单模型后它离开列表并有分；删除映射后回到未匹配
    6d. 隐藏一个有点的模型后，`points`、`noScore`、`links` 里都没有它，`hiddenModels` 列出它及其渠道，渠道 chip 的模型数不变；隐藏一个 `unmatched` 里的模型后它离开列表；恢复后都回来
    7. 系列判定，以及最新一代过滤和旧代例外（构造一个更便宜的旧代应该被保留，构造一个更贵的旧代应该被隐藏）
    8. 匹配优先级：人工 > 模糊 > LLM。LLM 层用假网关返回固定答案，结果标成 AI 猜测；确认后变成人工
    9. 无分数带，以及手动打分后的效果
    10. 存疑标记的系数
    11. 订阅计算器四种口径各一个手算用例，加上 RAP 预填用例（每个模型单独的折扣率）
    12. 写回：在沙盒里调用**真实的 magpie CLI**（`XDG_CONFIG_HOME` 和 `HOME` 都指向临时目录，做法同 intent-lab 的 e2e），检查 diff 和读回结果。**前后对比真实 `~/.config/magpie/` 下 providers.json 和 settings.json 的 sha256，必须没有变化**
    13. 没有口令或者 Host 不对的请求返回 403
- `bun run ui-shot`：用 Playwright 加载测试数据，截一张 `artifacts/ui-*.png`（默认对数刻度，打开 hover 状态）。
- `bun run frame-check`：在 sandbox iframe 加同款 CSP 的环境里，验证页面能导航到 service（照搬 intent-lab）。
