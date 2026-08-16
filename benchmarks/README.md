# Forge Benchmark

这个目录保存可重复创建的本地基准项目。每个 Case 只提供干净 Git 基线、初始测试和复杂度边界；正式需求、保证等级和通过预算在每轮测试前单独确认。

```text
benchmarks/
├── simple/    单模块、一个测试文件、一个行为完整 Task
├── medium/    三个调用链节点、跨模块数据流、一个集成测试 Seam
├── hard/      异步状态、持久化所有权和并发/恢复风险
├── prepare.mjs
└── report.mjs
```

## 创建基准仓库

```bash
npm run benchmark:prepare -- simple
npm run benchmark:prepare -- medium
npm run benchmark:prepare -- hard
```

命令会把对应 `fixture/` 复制到新的 `/tmp/pi-forge-benchmark-*` 目录，初始化 Git，运行基线测试并创建基线 Commit。它不会安装 Forge，也不会修改真实 Workspace。

## 运行

1. 阅读对应 Case 的 `CASE.md`。
2. 在生成的临时仓库中把待测源码安装为 Project-local Package：
   ```bash
   pi install -l /absolute/path/to/pi-forge-workflow
   ```
   确认 `.pi/settings.json` 指向该源码。只在 Coordinator 命令中用 `--extension` 不够，因为正式 Worker / Reviewer / Planner Subagent 会从项目 Package 配置加载 Forge；缺少这一步会把本地 Coordinator 与全局旧 Extension 混在同一 Runtime，结果无效。
3. 在生成的临时仓库中运行 `forge-init`。
4. 从 `forge-prd` 开始完成完整流程。
5. 工单完成后生成时间报告：

```bash
npm run benchmark:report -- /tmp/pi-forge-benchmark-xxxxxx
```

## 固定记录

每次测试至少记录：

```text
完整工作项时间
PRD Generation / Amendment 次数
Task Preflight Proposal 次数
Runtime 初始化到 Issue completed
Task Worker 时间
机械验证时间
Task Conformance Audit + Commit 时间
Slice Gate 时间
Final Issue Audit 时间、Generation 数量和 Carried Axis 数量
Agent 数量、Infrastructure Retry、Unknown Spawn Outcome 和 Blocker 数量
最终 Diff、测试结果和 Git 状态
```

`simple` 当前包含已跑过的 `normalizeUsername` Case。`medium` 已冻结为 Optional Request Timeout Contract：三个生产 Module、三个数据流节点、一个 Public Interface 变化、向后兼容的省略语义、显式零值、优先级分支、两个准确 Error Path 和一个 Integration Seam。`hard` 仍只冻结异步持久化与并发/恢复复杂度形状。
