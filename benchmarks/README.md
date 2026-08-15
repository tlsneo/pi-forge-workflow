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
2. 在生成的临时仓库中运行 `forge-init`。
3. 从 `forge-prd` 开始完成完整流程。
4. 工单完成后生成时间报告：

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
Final Issue Audit 时间
Agent 数量、基础设施 Retry 和 Blocker 数量
最终 Diff、测试结果和 Git 状态
```

`simple` 当前包含已跑过的 `normalizeUsername` Case。`medium` 和 `hard` 只冻结复杂度形状，最终需求将在后续讨论后确定。
