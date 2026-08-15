# Simple Case

复杂度边界：一个生产模块、一个测试文件、一个行为完整 Task、无依赖、无异步行为。

暂定需求：

```text
在 src/usernames.js 新增并导出 normalizeUsername(input)。
先去除首尾空白，再转换为小写。
处理后为空时抛出 Error("username must not be empty")。
保持 formatDisplayName 不变。
在现有测试文件增加三个精确测试。
```

目标：验证详细 Blueprint、逐步 Evidence、提交前 Task Conformance Audit 和标准保证 Final Audit 的最小固定成本。
