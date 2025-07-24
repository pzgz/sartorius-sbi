
'use strict';

var debug = require('debug')('SBI');

var app = require('express')();
var http = require('http').Server(app);
var io = require('socket.io')(http);

var Scale = require('../../src/index.js').Scale;
var TTY_DEFAULTS = require('../../src/index.js').TTY_DEFAULTS;

function getString(v) { return v; }
function getInt(i) { return parseInt(i); }

const { program } = require('commander');

const args = program
    .version(require('../../package.json').version)

    .option('-d --ttyDevice <dev>', 'device name [/dev/tty.USB0]', getString, TTY_DEFAULTS.ttyDevice)
    .option('-b --baudRate <baud>', '1200, [9600] or 38400', getInt, 9600)
    .option('--dataBits <bits>', '7 or [8]', getInt, 8)
    .option('--stopBits <bits>', '0 or [1]', getInt, 1)
    .option('--parity <parity>', 'odd, even or [none]', getString, 'none')

    .option('--rtscts', 'ready-to-send, clear-to-send')
    .option('--xon', 'xon handshake')
    .option('--xoff', 'xoff handshake')
    .option('--xany', 'xany handshake')

    .option('--responseTimeout <ms>', 'response timeout [200] milliseconds', getInt, 200)
    .option('--precision <places>', 'weight precision [1] or 2 decimal places', getInt, 1)
    .option('--dataFormat <format>', 'data format: [22] (with 6-bit ID) or 16 (standard)', getInt, 22)

    .option('--mode <mode>', 'monitoring mode: [passive] or active', getString, 'passive')
    .option('--pollInterval <ms>', 'poll interval for active mode [200] milliseconds', getInt, 200)

    .parse(process.argv)

    ;

const options = args.opts();

let scaleOptions = {

    ttyDevice: options.ttyDevice,
    baudRate: options.baudRate,
    dataBits: options.dataBits,
    stopBits: options.stopBits,
    parity: options.parity,

    rtscts: !!options.rtscts,
    xon: !!options.xon,
    xoff: !!options.xoff,
    xany: !!options.xany,

    responseTimeout: options.responseTimeout,
    precision: options.precision,
    dataFormat: options.dataFormat,

};

var serialNumber;
var deviceInfo;

var lastWeight;
var monitorPoll; // 用于存储主动监听的定时器引用

var scale = new Scale(scaleOptions, function (err) {
    if (err) {
        console.error('Unable To Connect To Serial Port');
        process.exit();
    }

    // 获取基本设备信息
    scale.deviceInfo(function (err, data) {
        if (err) return console.error(err);
        deviceInfo = data;
        console.log('Device Info:', deviceInfo);

        scale.serialNumber(function (err, data) {
            if (err) return console.error(err);
            serialNumber = data;
            console.log('Serial Number:', serialNumber);

            // 根据模式选择监听方式
            if (options.mode === 'passive') {
                console.log('Starting passive listening mode...');
                startPassiveMode();
            } else if (options.mode === 'active') {
                console.log('Starting active monitoring mode...');
                startActiveMode();
            } else {
                console.error('Invalid mode. Use "passive" or "active"');
                process.exit(1);
            }
        });
    });
});

// 被动监听模式
function startPassiveMode() {
    scale.startListening(function (err) {
        if (err) {
            console.error('Failed to start passive listening:', err);
            return;
        }

        console.log('✅ Passive listening started');

        // 监听重量变化事件
        scale.on('weight', function (weight, uom) {
            lastWeight = { weight: weight, uom: uom, timestamp: new Date().toISOString() };
            console.log('Weight changed:', lastWeight);
            io.emit('weight', lastWeight); // 广播重量变化
        });

        // 监听其他数据
        scale.on('data', function (rawData) {
            console.log('Raw data received:', rawData);
            io.emit('rawData', { data: rawData, timestamp: new Date().toISOString() });
        });

        // 监听错误
        scale.on('error', function (err) {
            console.error('Scale error:', err);
            io.emit('error', { error: err.message, timestamp: new Date().toISOString() });
        });
    });
}

// 主动监听模式（原有方式）
function startActiveMode() {
    scale.monitor(function (err, poll) {
        if (err) {
            console.error('Failed to start active monitoring:', err);
            return;
        }

        monitorPoll = poll;
        console.log('✅ Active monitoring started');

        scale.on('weight', function (weight, uom) {
            lastWeight = { weight: weight, uom: uom, timestamp: new Date().toISOString() };
            console.log('Weight changed:', lastWeight);
            io.emit('weight', lastWeight); // 广播重量变化
        });

        scale.on('key', (key, name) => {
            console.log('Key pressed:', name);
            io.emit('keyPress', { key: key, name: name, timestamp: new Date().toISOString() });

            switch (name) {
                case 'TOGGLE':
                    scale.toggle(function (err) {
                        if (!err) {
                            io.emit('toggled', { timestamp: new Date().toISOString() });
                        }
                    });
                    break;

                case 'TARE':
                    scale.tare(function (err) {
                        if (!err) {
                            io.emit('tared', { timestamp: new Date().toISOString() });
                        }
                    });
                    break;

                default:
                    console.log('Unhandled key press:', key, '(' + name + ')');
            }
        });
    }, options.pollInterval);
}

app.get('/', function (req, res) {
    res.sendFile(__dirname + '/index.html');
});

io.on('connection', function (socket) {
    debug(`connect (${socket.id})`);

    // 发送当前状态给新连接的客户端
    socket.emit('connected', {
        mode: options.mode,
        deviceInfo: deviceInfo,
        serialNumber: serialNumber,
        currentWeight: lastWeight,
        timestamp: new Date().toISOString()
    });

    // 如果有当前重量，立即发送
    if (lastWeight) {
        socket.emit('weight', lastWeight);
    }

    socket.on('disconnect', function () {
        debug(`disconnect (${socket.id})`);
    });

    // 获取设备信息
    socket.on('deviceInfo', function (msg, ack) {
        if (typeof ack === 'function') {
            ack({ deviceInfo: deviceInfo, timestamp: new Date().toISOString() });
        }
    });

    // 获取序列号
    socket.on('serialNumber', function (msg, ack) {
        if (typeof ack === 'function') {
            ack({ serialNumber: serialNumber, timestamp: new Date().toISOString() });
        }
    });

    // 主动获取当前重量
    socket.on('getWeight', function (msg, ack) {
        scale.weight(function (err, weight, uom) {
            const result = {
                success: !err,
                timestamp: new Date().toISOString()
            };

            if (err) {
                result.error = err.message;
            } else {
                result.weight = weight;
                result.uom = uom;
                lastWeight = { weight: weight, uom: uom, timestamp: result.timestamp };
            }

            if (typeof ack === 'function') {
                ack(result);
            }
        });
    });

    // 获取天平状态
    socket.on('getStatus', function (msg, ack) {
        scale.status(function (err, status) {
            const result = {
                success: !err,
                timestamp: new Date().toISOString()
            };

            if (err) {
                result.error = err.message;
            } else {
                result.status = status;
            }

            if (typeof ack === 'function') {
                ack(result);
            }
        });
    });

    // 执行归零
    socket.on('tare', function (msg, ack) {
        scale.tare(function (err) {
            const result = {
                success: !err,
                timestamp: new Date().toISOString()
            };

            if (err) {
                result.error = err.message;
            } else {
                result.message = 'Tare completed';
                io.emit('tared', result); // 广播给所有客户端
            }

            if (typeof ack === 'function') {
                ack(result);
            }
        });
    });

    // 切换称重模式
    socket.on('toggle', function (msg, ack) {
        scale.toggle(function (err) {
            const result = {
                success: !err,
                timestamp: new Date().toISOString()
            };

            if (err) {
                result.error = err.message;
            } else {
                result.message = 'Mode toggled';
                io.emit('toggled', result); // 广播给所有客户端
            }

            if (typeof ack === 'function') {
                ack(result);
            }
        });
    });

    // 在天平上显示消息
    socket.on('showMessage', function (msg, ack) {
        const message = msg && msg.text ? msg.text : '';
        scale.message(message, function (err) {
            const result = {
                success: !err,
                timestamp: new Date().toISOString()
            };

            if (err) {
                result.error = err.message;
            } else {
                result.message = 'Message displayed: ' + message;
            }

            if (typeof ack === 'function') {
                ack(result);
            }
        });
    });

    // 切换监听模式（仅在服务运行时）
    socket.on('switchMode', function (msg, ack) {
        const newMode = msg && msg.mode ? msg.mode : options.mode;

        if (newMode === options.mode) {
            if (typeof ack === 'function') {
                ack({
                    success: false,
                    error: 'Already in ' + newMode + ' mode',
                    timestamp: new Date().toISOString()
                });
            }
            return;
        }

        // 停止当前模式
        if (options.mode === 'active' && monitorPoll) {
            scale.cancel(monitorPoll);
            monitorPoll = null;
        } else if (options.mode === 'passive') {
            scale.stopListening();
        }

        // 切换到新模式
        options.mode = newMode;

        if (newMode === 'passive') {
            startPassiveMode();
        } else {
            startActiveMode();
        }

        const result = {
            success: true,
            message: 'Switched to ' + newMode + ' mode',
            currentMode: newMode,
            timestamp: new Date().toISOString()
        };

        // 通知所有客户端模式变化
        io.emit('modeChanged', result);

        if (typeof ack === 'function') {
            ack(result);
        }
    });

});

// 优雅关闭处理
process.on('SIGINT', function () {
    console.log('\nShutting down gracefully...');

    if (options.mode === 'active' && monitorPoll) {
        scale.cancel(monitorPoll, function () {
            console.log('Active monitoring stopped');
            process.exit(0);
        });
    } else if (options.mode === 'passive') {
        scale.stopListening(function () {
            console.log('Passive listening stopped');
            process.exit(0);
        });
    } else {
        process.exit(0);
    }
});

http.listen(3000, function (err) {
    if (err) return console.error(err);
    console.log('🚀 SBI HTTP Server listening on *:3000');
    console.log(`📊 Mode: ${options.mode}`);
    console.log(`📱 Device: ${options.ttyDevice}`);
    if (options.mode === 'active') {
        console.log(`⏱️  Poll interval: ${options.pollInterval}ms`);
    }
});
