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

手动重新获取模型列表：

```text
/magpie-sync
```

如果登录失败，请检查地址、网络连接、Magpie 的局域网共享设置以及 gateway key 是否有效。即使模型列表为空，登录仍会成功；之后可以通过 `/magpie-sync` 再次获取。
