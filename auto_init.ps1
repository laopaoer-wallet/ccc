#!/bin/bash

# 设置密钥文件路径
PRIVATE_KEY="$HOME/.ssh/id_ed25519"
PUBLIC_KEY="$PRIVATE_KEY.pub"
SERVER="dev-server"

# 自动检测系统类型选择配置文件路径
if [[ "$OSTYPE" == "msys" || "$OSTYPE" == "cygwin" ]]; then
    # Windows (Git Bash/Cygwin)
    SSH_CONFIG="$HOME/.ssh/config"
    echo "检测到Windows环境，将使用用户级SSH配置: $SSH_CONFIG"
else
    # Linux/macOS
    SSH_CONFIG="/etc/ssh/ssh_config"
    echo "检测到Unix环境，将使用系统级SSH配置: $SSH_CONFIG"
fi

# 获取用户名
read -p "请输入远程服务器用户名: " username

# 密钥生成（跨平台）
if [ ! -f "$PRIVATE_KEY" ]; then
    echo "生成Ed25519密钥对..."
    if ! ssh-keygen -t ed25519 -f "$PRIVATE_KEY" -N "" -q; then
        echo "错误：密钥生成失败"
        exit 1
    fi
fi

# 公钥复制（跨平台）
echo "复制公钥到服务器..."
if ! ssh-copy-id -i "$PUBLIC_KEY" "${username}@${SERVER}"; then
    echo "错误：公钥复制失败"
    exit 1
fi

# 配置写入（自动处理Windows权限）
CONFIG_CONTENT="
# 自动生成的开发服务器配置
Host $SERVER
    HostName $SERVER
    User $username
    Port 22
    IdentityFile $(cygpath -w "$PRIVATE_KEY" 2>/dev/null || echo "$PRIVATE_KEY")
    ServerAliveInterval 60
    ServerAliveCountMax 3
    ConnectTimeout 30
    TCPKeepAlive yes
    StrictHostKeyChecking accept-new"

if [[ "$OSTYPE" == "msys" || "$OSTYPE" == "cygwin" ]]; then
    # Windows环境写入用户目录
    mkdir -p "$HOME/.ssh"
    echo "$CONFIG_CONTENT" >> "$SSH_CONFIG"
else
    # Unix环境需要sudo
    echo "$CONFIG_CONTENT" | sudo tee -a "$SSH_CONFIG" >/dev/null
fi

echo "配置完成"
echo "已添加到: $SSH_CONFIG"
