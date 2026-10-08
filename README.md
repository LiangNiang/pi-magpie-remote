# pi-magpie-remote

通过 Pi 的 `/login` 连接到另一台机器上运行的 Magpie 网关。本扩展会读取网关中的模型列表，并将模型显示在 Pi 的 `/model` 选择器中。

## 安装

```sh
pi install git:github.com/LiangNiang/pi-magpie-remote
```

插件只有类型导入，运行时没有额外依赖。本地试用：

```sh
git clone https://github.com/LiangNiang/pi-magpie-remote
pi -e ./pi-magpie-remote
```

## 配置 Magpie

在 Magpie 中启用 **设置 → 局域网共享（Share on local network）**，并在网关的 **Gateway keys** 中创建客户端密钥。准备好从运行 Pi 的机器可以访问的网关地址和密钥。

## 登录和使用

在 Pi 中运行 `/login`，然后选择 **Magpie (remote)**。输入 Magpie 的共享地址（例如 `http://192.168.1.20:3425`）和 gateway key，扩展便会获取模型列表。Pi 会将连接信息和原始模型列表快照保存在 `~/.pi/agent/auth.json` 中。

```text
/model
```

模型会以 `magpie-remote/<Magpie 模型 ID>` 的形式显示。选择模型后即可像平常一样发送提示。

每次打开 `/model`（以及 pi 启动时）都会自动向远端重新拉取模型列表；远端连不上时使用 `auth.json` 中的快照。

如果登录失败，请检查地址、网络连接、Magpie 的局域网共享设置以及 gateway key 是否有效。即使模型列表为空，登录仍会成功；远端加了模型后重新打开 `/model` 即可看到。

## 查看额度

选中 `magpie-remote` 模型时，Pi 底部状态栏会显示该模型所属供应商在 Magpie 上的额度，例如 `codex 5h 82% · 7d 41%`（各窗口已用百分比）或 `deepseek ¥23.40`（key 余额）。同一供应商有多个账号时，优先显示最近一次经网关服务的账号，并附上 `+N` 表示还有几个账号。用量达到 75% 时变黄，达到 90% 时变红。状态会在 pi 启动、切换模型以及每次回复结束后刷新（最多每分钟拉取一次）。

查看全部供应商的额度：

```text
/magpie-quota
/magpie-quota codex
```

输出内容与 Magpie 机器上 `magpie quota` 的结果一致：每个订阅、套餐的各窗口用量和重置时间（↻），以及各 key 的余额。数据来自网关的 `GET /v1/magpie/quotas`，使用 `/login` 时保存的地址和 gateway key，因此同样需要开启局域网共享。

## 冒烟测试

对正在使用的 Magpie 做只读检查（拉取模型列表和额度，不发起对话）：

```sh
MAGPIE_URL=http://192.168.1.10:3425 MAGPIE_GATEWAY_KEY=sk-magpie-... npm run smoke
```

未设置 `MAGPIE_URL` 时测试会跳过。
