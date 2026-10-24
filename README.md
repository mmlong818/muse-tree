# Muse Tree 公开候选包

这是从一份 Muse home 目录快照中整理出的公开仓库。仓库保留了现有项目中的产品说明、技能与连接器定义、Space 模板和 TypeScript 运行时源码、Magic Moment 工具源码，以及根目录中的通用 agent 行为文件。

本仓库并非 Meta 或 Muse 的官方发行版，也不保证能在普通电脑上独立运行：部分文件依赖 Muse VM、内部运行时路径、daemon、浏览器镜像、连接器和服务端能力。第三方权利和明确受限资产仍按各自条款独立适用，并遵循下述排除边界。

## 当前包含

- `AGENTS.md`、`IDENTITY.md`、`SOUL.md`：当前快照中的通用 agent 行为与身份文件。
- `docs/`：Muse 产品、功能、隐私和数据处理说明。
- `skills/`：技能、连接器、manifest、参考资料和相关源码；不含航空公司 logo 资产。
- `spaces/`：Space 模板、TypeScript SDK、worker、Cloudflare/CVM 工具和 Muse UI 源码；不含图标包、`dist/` 或 `node_modules/`。
- `magic-moment/`：Magic Moment 的流程、脚本、设计资料和渲染源码；不含字体文件。

## 已排除

为避免公开个人数据、运行状态、大型二进制、品牌资源、受限字体以及可重新生成的依赖和构建产物，候选包没有复制以下内容：

- 根目录：`MEMORY.md`、`USER.md`、`PROACTIVE_PREFERENCES.md`、`TOOLS.md`、`HEARTBEAT.md`。
- 目录：`memory/`、`dreams/`、`user/`、`workspace/`、`subscriptions/`、`config/`、`hooks/`、`assets/`。
- 所有层级的 `.git/`、`node_modules/`、`dist/`、缓存、日志和覆盖率输出。
- `magic-moment/assets/fonts/`。原快照中的 `Optimistic` 字体许可证明确限定为 Meta 内部、Muse 产品内使用。
- `skills/booking/assets/airline-logos/`。原说明表明这些 logo 分属各航空公司或运营方。
- `spaces/icons/`。该目录包含产品图标资源，权属尚未确认。

## 构建与运行边界

根目录没有统一构建入口。主要可识别的源码模块是 `spaces/ts-runtime/`，其文档说明使用 Bun：

```bash
cd spaces/ts-runtime
bun build.mjs
```

Cloudflare exporter 和相关测试的命令记录在 `spaces/ts-runtime/README.md`。这些流程引用 Muse/Hatch 的内部路径与运行时契约，因此本候选包没有把“能够在独立环境完整构建和运行”作为已验证结论。

`magic-moment/` 同样依赖 Muse VM 中预置的 PIL、ffmpeg、Chromium、Playwright bundle 和转写服务。它的 `install.sh --check` 只适用于相应运行环境。

## 发布状态与边界

1. 最终仓库已经确认为 `mmlong818/muse-tree`，可见性为 `public`。
2. 当前不添加仓库级开源许可证；没有许可证时，默认保留全部权利，其他人不能据此自由复制、修改和分发。
3. 受限字体、第三方 logo、个人状态、生成依赖和大型产品资产仍按本文件所列边界排除。

首次发布以本文件列出的包含与排除边界为准；后续加入个人状态、生成依赖或第三方资产前，应重新审阅其隐私与授权条件。
