/**
 * WebSerial Scale - Browser-based implementation for Sartorius Balance Interface
 * 
 * This implements the same functionality as the Node.js backend but using WebSerial API
 * to communicate directly with the scale from the browser.
 */

// SBI Protocol Constants (ported from src/lib/sbi.js)
const SBI = {
  ESC: "\x1B",

  // Key definitions
  KEY: {
    NO_KEY: '        000   ',
    NO_KEY_LP: '        000   ',
    TARE: '        051   ',
    TARE_LP: '        053   ',
    TOGGLE: '        042   ',
    TOGGLE_LP: '        044   ',
    CLEAR: '        120   ',
    CLEAR_LP: '        122   ',
    ENTER: '        119   ',
    ENTER_LP: '        121   ',
    UP: '        123   ',
    UP_LP: '        125   ',
    DOWN: '        124   ',
    DOWN_LP: '        126   ',
    FUNC: '        116   ',
    FUNC_LP: '        118   '
  },

  // Key lookup table
  KEY_LOOKUP: {
    '        000   ': 'NO_KEY',
    '        051   ': 'TARE',
    '        053   ': 'TARE_LP',
    '        042   ': 'TOGGLE',
    '        044   ': 'TOGGLE_LP',
    '        120   ': 'CLEAR',
    '        122   ': 'CLEAR_LP',
    '        119   ': 'ENTER',
    '        121   ': 'ENTER_LP',
    '        123   ': 'UP',
    '        125   ': 'UP_LP',
    '        124   ': 'DOWN',
    '        126   ': 'DOWN_LP',
    '        116   ': 'FUNC',
    '        118   ': 'FUNC_LP'
  },

  // Commands
  get PRINT() { return this.ESC + "P"; },
  get TARE() { return this.ESC + "T"; },
  get DEVICE_INFO() { return this.ESC + "x1_"; },
  get SERIAL_NUMBER() { return this.ESC + "x2_"; },
  get FIRMWARE_VERSION() { return this.ESC + "x3_"; },
  get MIN_WEIGHT() { return this.ESC + "x4_"; },
  get MAX_WEIGHT() { return this.ESC + "x5_"; },
  get LAST_KEY_PRESS() { return this.ESC + "x8_"; },
  get TOGGLE_WEIGH_MODE() { return this.ESC + "f0_"; },
  get LOCK_KEYBOARD() { return this.ESC + "O"; },
  get RELEASE_KEYBOARD() { return this.ESC + "R"; },

  // Helper functions
  MSG: function (msg) {
    return this.ESC + 'a3' + msg + '_';
  }
};

/**
 * Simple EventEmitter implementation for the browser
 */
class EventEmitter {
  constructor() {
    this.events = {};
  }

  on(event, listener) {
    if (!this.events[event]) {
      this.events[event] = [];
    }
    this.events[event].push(listener);
  }

  emit(event, ...args) {
    if (this.events[event]) {
      this.events[event].forEach(listener => {
        try {
          listener(...args);
        } catch (error) {
          console.error('Error in event listener:', error);
        }
      });
    }
  }

  removeListener(event, listener) {
    if (this.events[event]) {
      this.events[event] = this.events[event].filter(l => l !== listener);
    }
  }
}

/**
 * WebSerial Scale Class
 * Implements the same interface as the Node.js Scale class but using WebSerial API
 */
class WebSerialScale extends EventEmitter {
  constructor(options = {}) {
    super();

    this.options = {
      baudRate: 9600,
      dataBits: 8,
      parity: "odd", // Changed to "odd" as default for Sartorius scales
      stopBits: 1,
      flowControl: "none",
      responseTimeout: 200,
      precision: 3,
      dataFormat: 22, // Default to 22-bit format (20 chars after CRLF removal)
      ...options
    };

    this.port = null;
    this.writer = null;
    this.reader = null;
    this.readableStreamClosed = null;
    this.writableStreamClosed = null;
    this.isConnected = false;
    this.isListening = false;
    this.lastWeight = undefined;
    this.lastUom = undefined;
  }

  /**
   * Connect to the scale via WebSerial
   */
  async connect() {
    try {
      // Check WebSerial support
      if (!('serial' in navigator)) {
        throw new Error('WebSerial not supported in this browser');
      }

      // Request port
      this.port = await navigator.serial.requestPort();

      // Open the port with scale-specific settings
      await this.port.open({
        baudRate: this.options.baudRate,
        dataBits: this.options.dataBits,
        parity: this.options.parity,
        stopBits: this.options.stopBits,
        flowControl: this.options.flowControl
      });

      // Set up writer and reader
      this.writer = this.port.writable.getWriter();
      this.reader = this.port.readable.getReader();

      this.isConnected = true;

      // Test connection by querying device info
      try {
        console.log('Testing scale connection...');
        const deviceInfo = await this.query(SBI.DEVICE_INFO);
        console.log('Scale connection verified, device info:', deviceInfo);
      } catch (error) {
        console.error('Scale verification failed:', error);
        await this.disconnect();
        throw new Error(`Connected to serial port but no compatible scale found. Error: ${error.message}. Please check:\n1. Scale is powered on\n2. Correct serial port selected\n3. Connection parameters match scale settings\n4. Scale is in the correct mode`);
      }

    } catch (error) {
      console.error('Connection failed:', error);
      throw error;
    }
  }

  /**
   * Disconnect from the scale
   */
  async disconnect() {
    try {
      this.isConnected = false;
      this.stopListening();

      if (this.reader) {
        await this.reader.cancel();
        await this.reader.releaseLock();
        this.reader = null;
      }

      if (this.writer) {
        await this.writer.close();
        this.writer = null;
      }

      if (this.port) {
        await this.port.close();
        this.port = null;
      }
    } catch (error) {
      console.error('Disconnect error:', error);
    }
  }

  /**
   * Send data to the scale
   */
  async send(data) {
    if (!this.isConnected || !this.writer) {
      throw new Error('Not connected to scale');
    }

    const encoder = new TextEncoder();
    const dataToSend = encoder.encode(data);

    console.log(`Sending: "${data.trim()}" (${dataToSend.length} bytes)`);

    await this.writer.write(dataToSend);
  }

  /**
   * Read data from the scale with timeout
   */
  async readWithTimeout(timeout = null) {
    if (!this.isConnected || !this.reader) {
      throw new Error('Not connected to scale');
    }

    const readTimeout = timeout || this.options.responseTimeout;

    return new Promise(async (resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Response timeout'));
      }, readTimeout);

      try {
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { value, done } = await this.reader.read();

          if (done) {
            clearTimeout(timer);
            reject(new Error('Reader stream closed'));
            return;
          }

          const chunk = decoder.decode(value, { stream: true });
          buffer += chunk;

          // Look for complete line (ending with \r\n)
          const lines = buffer.split('\r\n');
          if (lines.length > 1) {
            clearTimeout(timer);
            const response = lines[0];

            // Put remaining data back (if any)
            buffer = lines.slice(1).join('\r\n');

            console.log(`Received: "${response.trim()}" (${response.length} bytes)`);
            resolve(response);
            return;
          }
        }
      } catch (error) {
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  /**
   * Send query and wait for response
   */
  async query(command, timeout = null) {
    await this.send(command);
    return await this.readWithTimeout(timeout);
  }

  /**
   * Extract weight from scale response
   * Supports both 16-bit (14 chars) and 22-bit (20 chars) formats
   */
  extractWeight(data) {
    let signIndex, weightStart, weightEnd, uomStart, uomEnd;

    if (this.options.dataFormat === 22) {
      // 22-bit format: 6-bit ID + 14-bit weight data (20 chars total after CRLF removal)
      if (data.length !== 20) {
        throw new Error(`Bad weight - wrong length for 22-bit format. Expected 20, got ${data.length}`);
      }
      // Skip first 6 characters (ID), then parse weight data
      signIndex = 6;
      weightStart = 7;
      weightEnd = 17;
      uomStart = 17;
      uomEnd = 20;
    } else {
      // 16-bit format: 14-bit weight data (14 chars total after CRLF removal)
      if (data.length !== 14) {
        throw new Error(`Bad weight - wrong length for 16-bit format. Expected 14, got ${data.length}`);
      }
      signIndex = 0;
      weightStart = 1;
      weightEnd = 11;
      uomStart = 11;
      uomEnd = 14;
    }

    if (!(data[signIndex] === " " || data[signIndex] === "+" || data[signIndex] === "-")) {
      throw new Error('Bad weight - wrong sign');
    }

    const sign = data[signIndex] === "-" ? -1 : 1;
    const weightString = data.substring(weightStart, weightEnd);
    const weight = Math.round(sign * Number(weightString) * Math.pow(10, this.options.precision)) / Math.pow(10, this.options.precision);

    if (isNaN(weight)) {
      throw new Error('Bad weight - not a number');
    }

    const uom = data.substring(uomStart, uomEnd).trim();

    // Note: empty uom means the scale isn't stable yet.
    if (!(uom === "" || uom === "g" || uom === "/lb")) {
      throw new Error('Bad weight - invalid unit of measure');
    }

    return { weight, uom };
  }

  /**
   * Get current weight from scale
   */
  async getWeight() {
    const response = await this.query(SBI.PRINT);
    return this.extractWeight(response);
  }

  /**
   * Tare the scale (zero it)
   */
  async tare() {
    await this.send(SBI.TARE);
  }

  /**
   * Toggle weighing mode (g <-> /lb)
   */
  async toggle() {
    await this.send(SBI.TOGGLE_WEIGH_MODE);
  }

  /**
   * Get device information
   */
  async getDeviceInfo() {
    const response = await this.query(SBI.DEVICE_INFO);
    return response.trim();
  }

  /**
   * Get serial number
   */
  async getSerialNumber() {
    const response = await this.query(SBI.SERIAL_NUMBER);
    return response.trim();
  }

  /**
   * Show message on scale display
   */
  async showMessage(message = "") {
    await this.send(SBI.MSG(message));
  }

  /**
   * Start passive listening mode (like the Node.js passive mode)
   * This continuously reads data from the scale and emits events
   */
  startListening() {
    if (this.isListening) {
      return;
    }

    this.isListening = true;
    this._startPassiveReading();
    this.emit('listening');
  }

  /**
   * Stop passive listening mode
   */
  stopListening() {
    this.isListening = false;
    this.emit('stopped');
  }

  /**
   * Internal method to continuously read data in passive mode
   */
  async _startPassiveReading() {
    if (!this.isConnected || !this.reader) {
      return;
    }

    try {
      const decoder = new TextDecoder();
      let buffer = '';

      while (this.isListening && this.isConnected) {
        try {
          const { value, done } = await this.reader.read();

          if (done) {
            console.log('Reader stream closed');
            break;
          }

          const chunk = decoder.decode(value, { stream: true });
          buffer += chunk;

          // Process complete lines
          const lines = buffer.split('\r\n');
          buffer = lines.pop() || ''; // Keep incomplete line in buffer

          for (const line of lines) {
            if (line.length > 0) {
              this._processIncomingData(line);
            }
          }

        } catch (error) {
          if (this.isListening) {
            console.error('Error reading from scale:', error);
            this.emit('error', error.message);

            // Wait a bit before retrying
            await new Promise(resolve => setTimeout(resolve, 100));
          }
        }
      }
    } catch (error) {
      console.error('Passive reading error:', error);
      this.emit('error', error.message);
    }
  }

  /**
 * Process incoming data and emit appropriate events
 */
  _processIncomingData(data) {
    console.log(`Processing incoming data: "${data.trim()}" (length: ${data.length})`);

    // Try to parse as weight data (check both 14-bit and 20-bit formats)
    const expectedLength = this.options.dataFormat === 22 ? 20 : 14;
    if (data.length === expectedLength) {
      try {
        const { weight, uom } = this.extractWeight(data);

        // Only emit if weight has changed
        if (!(weight === this.lastWeight && uom === this.lastUom)) {
          this.lastWeight = weight;
          this.lastUom = uom;
          this.emit('weight', weight, uom);
        }
        return;
      } catch (error) {
        // Not weight data, continue to other processing
        console.log(`Failed to parse as weight data: ${error.message}`);
      }
    }

    // Check if it's a key press response
    if (SBI.KEY_LOOKUP[data]) {
      const keyName = SBI.KEY_LOOKUP[data];
      if (keyName !== 'NO_KEY') {
        this.emit('key', data, keyName);

        // Handle automatic responses to certain key presses
        this._handleKeyPress(keyName);
      }
      return;
    }

    // Emit as raw data for other types of responses
    this.emit('data', data.trim());
  }

  /**
   * Handle key press events automatically (like the Node.js implementation)
   */
  _handleKeyPress(keyName) {
    console.log('Key pressed:', keyName);

    // You can add automatic responses here if needed
    // For now, just emit the event for the UI to handle
  }

  /**
   * Get scale status
   */
  async getStatus() {
    try {
      await this.getDeviceInfo();

      try {
        await this.query(SBI.PRINT);
        return 'ready';
      } catch (error) {
        return 'locked';
      }
    } catch (error) {
      return 'disconnected';
    }
  }
}

// Make WebSerialScale available globally
window.WebSerialScale = WebSerialScale; 