# Sartorius SBI HTTP 服务器

支持双模式的 Sartorius 天平 HTTP 服务器，提供被动监听和主动轮询两种工作模式。

## 🚀 快速开始

### 1. 启动服务器

```bash
# 进入目录
cd tools/sbi-httpd

# 被动监听模式（推荐）
node index.js --mode passive --ttyDevice /dev/ttyUSB0

# 主动轮询模式
node index.js --mode active --ttyDevice /dev/ttyUSB0 --pollInterval 300
```

### 2. 访问 Web 界面

打开浏览器访问：http://localhost:3000

## 📊 命令行参数

| 参数 | 描述 | 默认值 | 示例 |
|------|------|--------|------|
| `--mode` | 监听模式：passive 或 active | passive | `--mode active` |
| `--ttyDevice` | 串口设备路径 | /dev/ttyUSB0 | `--ttyDevice /dev/ttyACM0` |
| `--baudRate` | 波特率 | 9600 | `--baudRate 38400` |
| `--responseTimeout` | 响应超时时间(ms) | 200 | `--responseTimeout 500` |
| `--precision` | 重量精度(小数位) | 1 | `--precision 2` |
| `--pollInterval` | 主动模式轮询间隔(ms) | 200 | `--pollInterval 300` |

## 🌐 Web 界面功能

### 状态栏
- **Model**: 天平型号和序列号
- **Mode**: 当前监听模式（passive/active）
- **Status**: 连接状态（Connected/Disconnected）

### 重量显示
- 大字体显示当前重量和单位
- 实时更新（被动模式）或按需获取（主动模式）

### 控制按钮

#### 基本操作
- **Tare**: 归零操作
- **Toggle**: 切换称重单位（g ↔ /lb）

#### 主动获取
- **🔄 Get Weight**: 立即获取当前重量
- **📊 Get Status**: 获取天平状态
- **💬 Show Message**: 在天平显示屏显示消息

#### 模式控制
- **📡 Passive Mode**: 切换到被动监听模式
- **🔄 Active Mode**: 切换到主动轮询模式
- **🗑️ Clear Log**: 清空操作日志

### 操作日志
- 实时显示所有操作和系统事件
- 彩色标记：
  - 🔵 蓝色：系统事件
  - 🟡 黄色：物理按键操作
  - 🔵 浅蓝：网页操作
  - 🟢 绿色：成功操作
  - 🔴 红色：错误信息

## 📡 API 接口

### Socket.IO 事件

#### 客户端 → 服务器

```javascript
// 获取重量
socket.emit('getWeight', {}, (response) => {
    console.log(response); // {success: true, weight: 123.4, uom: 'g'}
});

// 执行归零
socket.emit('tare', {}, (response) => {
    console.log(response); // {success: true, message: 'Tare completed'}
});

// 切换模式
socket.emit('switchMode', {mode: 'passive'}, (response) => {
    console.log(response); // {success: true, currentMode: 'passive'}
});
```

#### 服务器 → 客户端

```javascript
// 监听重量变化
socket.on('weight', (data) => {
    console.log(data); // {weight: 123.4, uom: 'g', timestamp: '...'}
});

// 监听连接状态
socket.on('connected', (data) => {
    console.log(data); // {mode: 'passive', deviceInfo: '...', ...}
});

// 监听模式变化
socket.on('modeChanged', (data) => {
    console.log(data); // {currentMode: 'active', message: '...'}
});
```

## 🔄 两种工作模式

### 被动监听模式（推荐）

**特点**：
- ✅ 低串口负载
- ✅ 低资源消耗  
- ✅ 实时响应（如果天平配置正确）
- ❌ 不支持按键监听

**适用场景**：
- 天平配置为自动发送重量数据
- 不需要监听物理按键操作
- 对系统资源要求较高的环境

### 主动轮询模式

**特点**：
- ✅ 支持按键监听
- ✅ 固定间隔获取数据
- ❌ 较高串口负载
- ❌ 较高资源消耗

**适用场景**：
- 需要监听天平物理按键
- 天平未配置自动发送数据
- 需要严格的定时获取

## 🛠️ 故障排除

### 连接问题

```bash
# 检查串口设备
ls -la /dev/tty*

# 设置权限
sudo chmod 666 /dev/ttyUSB0

# 检查设备占用
lsof /dev/ttyUSB0
```

### 常见错误

1. **Permission denied**: 串口权限不足
   ```bash
   sudo usermod -a -G dialout $USER
   # 重新登录后生效
   ```

2. **Device busy**: 设备被其他程序占用
   ```bash
   sudo pkill -f "ttyUSB0"
   ```

3. **No data**: 被动模式下无数据
   - 检查天平是否配置为自动发送数据
   - 尝试切换到主动模式

## 💻 开发示例

### Node.js 客户端

```javascript
const io = require('socket.io-client');
const socket = io('http://localhost:3000');

socket.on('connect', () => {
    console.log('✅ 连接成功');
    
    // 获取当前重量
    socket.emit('getWeight', {}, (response) => {
        if (response.success) {
            console.log(`重量: ${response.weight} ${response.uom}`);
        }
    });
});

// 监听重量变化
socket.on('weight', (data) => {
    console.log(`重量变化: ${data.weight} ${data.uom}`);
});
```

### 浏览器客户端

```html
<script src="/socket.io/socket.io.js"></script>
<script>
const socket = io();

socket.on('weight', (data) => {
    document.getElementById('weight').textContent = 
        `${data.weight} ${data.uom}`;
});

function getWeight() {
    socket.emit('getWeight', {}, (response) => {
        console.log('当前重量:', response);
    });
}
</script>
```

## 📝 注意事项

1. **设备独占**: 同一时间只能有一个程序连接天平
2. **权限管理**: 确保用户有串口设备的读写权限
3. **网络安全**: 生产环境建议配置防火墙和访问控制
4. **浏览器兼容**: 支持现代浏览器（Chrome、Firefox、Safari、Edge）
5. **模式切换**: 可在运行时动态切换监听模式，无需重启服务器

## 🔧 技术栈

- **后端**: Node.js + Express + Socket.IO
- **前端**: HTML + Bootstrap 3 + jQuery
- **串口**: SerialPort + @serialport/parser-readline
- **协议**: Sartorius SBI Protocol

---

更多技术细节请参考项目源码和 [主项目 README](../../README.md)。 