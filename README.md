# pi-magpie-remote

让 [Pi](https://pi.dev) 使用另一台机器上运行的 [Magpie](https://github.com/yetone/magpie) 网关：通过 `/login` 填入网关地址和 gateway key，Magpie 上的模型就会出现在 Pi 的 `/model` 中，底部状态栏还会显示当前模型对应供应商的额度，Agent 还能用网关上的模型生成图片和视频。

- **远程模型**：注册 `magpie-remote` 供应商，模型以 `magpie-remote/<Magpie 模型 ID>` 显示，自动按模型原生接口选择 Responses / Messages / Chat Completions，并带上推理强度（thinking level）。
- **自动刷新**：pi 启动和每次打开 `/model` 时重新拉取模型列表，远端不可达时使用本地快照。
- **额度显示**：状态栏显示当前供应商的窗口用量或余额，`/magpie-quota` 查看全部额度。
- **图片与视频**：`generate_image`、`generate_video` 两个工具用网关上的画图 / 视频模型出图、出片，文件存进当前项目。
- **零依赖**：只使用 pi 自带的包和 Node 内置模块，没有额外的运行时依赖。

## 安装

```sh
pi install git:github.com/LiangNiang/pi-magpie-remote
```

本地试用：

```sh
git clone https://github.com/LiangNiang/pi-magpie-remote
pi -e ./pi-magpie-remote
```

## 配置 Magpie

在运行 Magpie 的机器上：

1. 开启 **设置 → 局域网共享（Share on local network）**。
2. 运行 `magpie gateway-key add` 创建一个给 Pi 用的 gateway key。

记下从 Pi 所在机器能访问到的地址（例如 `http://192.168.1.20:3425`）和刚创建的 key。

## 登录

在 Pi 中运行 `/login`，选择 **Magpie (remote)**，依次输入网关地址和 gateway key。地址带不带 `/v1` 都可以。

![/login 输入网关地址和 gateway key](docs/images/login.png)

登录成功后，连接信息和模型列表快照保存在 `~/.pi/agent/auth.json`。Pi 随后会提示该供应商还没有默认模型，用 `/model` 选择一个即可。

如果登录失败，请检查地址、网络连通性、局域网共享开关以及 gateway key 是否有效。模型列表为空时登录也会成功，远端添加模型后重新打开 `/model` 即可看到。

## 选择模型

```text
/model
```

![/model 中显示的 Magpie 模型](docs/images/model.png)

按 Enter 选择本次会话使用的模型，按 Ctrl+S 设为默认模型。之后像平常一样发送提示即可。

## 查看额度

选中 `magpie-remote` 模型后，Pi 底部状态栏最后一行会显示该模型所属供应商在 Magpie 上的额度：

- 订阅 / 套餐显示各窗口已用百分比，例如 `codex 5h 32% · 7d 71%`；
- 按量付费的 key 显示余额，例如 `deepseek ¥23.40`；
- 同一供应商有多个账号时，优先显示最近一次经网关服务的账号，`+N` 表示还有 N 个账号。

用量达到 75% 时变黄，达到 90% 时变红：

![用量超过 90% 时状态栏变红](docs/images/footer-red.png)

状态会在 pi 启动、切换模型以及每次回复结束后刷新（最多每分钟拉取一次）。

查看全部供应商的额度，或只看某个供应商：

```text
/magpie-quota
/magpie-quota codex
```

![/magpie-quota 输出](docs/images/quota.png)

输出与 Magpie 机器上 `magpie quota` 一致：每个订阅、套餐各窗口的用量和重置时间（↻），以及各 key 的余额。数据来自网关的 `GET /v1/magpie/quotas`，使用 `/login` 时保存的地址和 gateway key，因此同样需要开启局域网共享。

> 截图中的模型和额度为演示数据。

## 生成图片和视频

登录后，Agent 多出两个工具，复用 `/login` 保存的地址和 gateway key，不需要另配密钥。直接对 Agent 说要画什么或拍什么即可，例如「生成一张 16:9 的机房插画，存到 `assets/hero.png`」。

| 工具 | 网关接口 | 默认保存位置 | 常用参数 |
| --- | --- | --- | --- |
| `generate_image` | `/v1/images/generations`；给出 `reference_images` 时走 `/v1/images/edits` | `generated-images/` | `prompt`、`path`、`size`（`1536x1024` 或 `16:9`）、`n`（1–4）、`quality`、`background`、`model`、`reference_images` |
| `generate_video` | `POST /v1/videos`，轮询完成后下载 `/content` | `generated-videos/` | `prompt`、`path`、`seconds`（1–15）、`size`（`16:9` 或 `1280x720`）、`image`（首帧）、`reference_images`、`model` |

- 参考图可以是本地路径、http(s) URL 或 data URL，本地文件会转成 data URL 上传。
- `path` 可以是文件或目录。已有文件不会被覆盖，重名时自动加 `-2`、`-3`。扩展名按实际返回的格式决定：要求 `hero.png` 但模型回的是 JPEG 时，保存为 `hero.jpg` 并在结果里说明。
- 只把文件路径返回给模型，不把图片或视频放进对话。
- 单次出图最多等 10 分钟，视频最多等 10 分钟，都可以按 Esc 中止。
- 请求带 `User-Agent: pi magpie-image/1`，Magpie 的用量页会把这些调用记在 `pi` 名下。

不指定 `model` 时由 Magpie 选择（Settings → Images 中设置的模型）。也可以用环境变量设默认模型，工具参数 `model` 优先：

- `PI_MAGPIE_IMAGE_MODEL`：例如 `codex/gpt-image-2`
- `PI_MAGPIE_VIDEO_MODEL`：例如 `grok/grok-imagine-video`

网关上有哪些模型可用：

```sh
curl -H "Authorization: Bearer <gateway key>" -H "X-Magpie-Drawers: 1" -H "X-Magpie-Videomakers: 1" https://<magpie>/v1/models
```

返回中 `"kind": "image"` 的是画图模型，`"kind": "video"` 的是视频模型。

## 开发

```sh
npm install
npm run check   # 类型检查
npm test        # 单元测试
```

对正在使用的 Magpie 做只读冒烟测试（拉取模型列表和额度，不发起对话，不消耗额度）：

```sh
MAGPIE_URL=http://192.168.1.20:3425 MAGPIE_GATEWAY_KEY=sk-magpie-... npm run smoke
```

未设置 `MAGPIE_URL` 时冒烟测试会跳过。
