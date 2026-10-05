# ANT BMS Web 开发约定

## 项目目标

这是一个手机优先的 ANT BMS Web Bluetooth 监测页面。它只读取并展示保护板数据，例如 SOC、容量、单体电压、温度、MOS 状态、均衡、保护和告警信息。

## 技术栈

- Vite + React + TypeScript（严格模式）。
- 组件使用 `.tsx`，协议、解析和通用逻辑使用 `.ts`。
- 样式集中在 `src/styles.css`；保持移动端优先，主操作在小屏幕下必须方便单手触达。

## BMS 与安全边界

- 默认并且始终保持**只读**：只允许发现 BLE 服务、订阅通知和发送状态读取帧。
- 不得新增写保护参数、MOS 控制、校准、复位、升级、密码/权限认证等功能，除非用户在当前任务明确要求。
- 保持 ANT 帧校验、分包拼接和 CRC-16/Modbus 校验；不要为了简化 UI 移除它们。
- 解析新增字段时，以当前工作区解包的官方微信小程序实现为参考，并为短帧或缺失字段保留安全降级显示。
- 所有连接异常都应显示为用户可理解的中文，不应让页面崩溃。

## 开发与验证

```bash
npm install
npx tsc --noEmit
npm run build
npm run dev
```

- 改动 TypeScript 后，至少运行 `npx tsc --noEmit` 和 `npm run build`。
- `dist/` 是构建产物，不提交；`node_modules/`、`.idea/`、`.openai/` 和 `.env*` 同样不提交。
- 修改协议解析时，优先添加可独立验证的纯函数，而不要把二进制解析逻辑塞进 React 组件。

## 交付与 Git

- 本项目默认只在本地构建。不要上传、部署或创建外部 Site，除非用户明确要求。
- 提交前检查 `git diff --check` 和 `git status --short`，避免提交构建产物或 IDE 文件。
- 提交信息使用简洁英文 Conventional Commit 风格，例如 `feat: show cell voltage summary`。
