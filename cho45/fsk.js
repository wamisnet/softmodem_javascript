

FSK = function () { this.init.apply(this, arguments) };
FSK.prototype = {
	init : function (opts) {
		var self = this;
		self.markFreq  = opts.markFreq  || 4900;
		self.spaceFreq = opts.spaceFreq || 7350;
		self.baudrate  = opts.baudrate  || 1225;
		self.startBit  = opts.startBit  || 1;
		self.stopBit   = opts.stopBit   || 1.5;
		self.threshold = opts.threshold || 0.0001;
		self.byteUnit  = 8;

		if (!FSK.context) FSK.context = new AudioContext();
		self.context = FSK.context;
		self.DOWNSAMPLE_FACTOR = opts.DOWNSAMPLE_FACTOR || 8;
		self.audioNodes = [];
	},

	/*
	 *
	 * @return  AudioBuffer
	 */
	modulate : function (bytes, opts) {
		var self = this;
		if (!opts) opts = {};

		if (typeof bytes == 'string') {
			var b = [];
			for (var i = 0, len = bytes.length; i < len; i++) {
				b.push(bytes.charCodeAt(i) & 0xff);
			}
			bytes = b;
		}
		console.log(bytes.length, bytes);

		var unit      = self.context.sampleRate / self.baudrate;
		var wait      = opts.wait || 30;
		var bitsPerByte = self.byteUnit + self.startBit + self.stopBit;

		var buffer    = self.context.createBuffer(1, bytes.length * bitsPerByte * unit + (wait * 2 * unit), self.context.sampleRate);
		var data      = buffer.getChannelData(0);
		var position  = 0;

		var phase = 0;
		var markToneDelta = 2 * Math.PI * self.markFreq / self.context.sampleRate;  
		var spaceToneDelta = 2 * Math.PI * self.spaceFreq / self.context.sampleRate;  

		function sendBit (bit, length) {
			var tone = bit ? markToneDelta : spaceToneDelta;
			var len = length * unit;
			for (var i = 0; i < len; i++) {
				phase += tone;
				data[position++] = Math.sin(phase);
			}
		}

		function sendByte (byte) {
			sendBit(0, self.startBit);
			for (var b = 0; b < self.byteUnit; b++) {
				//  least significant bit first
				if (byte & (1<<b)) {
					sendBit(1, 1);
				} else {
					sendBit(0, 1);
				}
			}
			sendBit(1, self.stopBit);
		}

		sendBit(1, wait);
		for (var i = 0, len = bytes.length; i < len; i++) {
			sendByte(bytes[i]);
		}
		sendBit(1, wait);
		
		if (opts.play) {
			var source = self.context.createBufferSource();
			source.buffer = buffer;
			source.connect(opts.play);
			source.start(0);
		}

		return buffer;
	},

	/*
	 *
	 */
	demodulate : function (source, callback) {
		var self = this;
		var detection = self._detectCoherent(source);

		var unit  = Math.round(self.context.sampleRate / self.DOWNSAMPLE_FACTOR / self.baudrate);
		var current = {
			state : "waiting",
			total : 0,
			mark  : 0,
			space : 0,
			bit   : 0,
			byte  : 0,
			data  : 0
		};

		var states = {
			"waiting": function () {
				if (current.data === -1) {
					current.state = "start";
				} else {
					current.total = 0;
				}
			},
			"start": function () {
				if (current.data ===  1) current.mark++;
				if (current.data === -1) current.space++;
				if ( (unit * self.startBit) <= current.total) {
					if (current.mark < current.space) {
						current.mark = 0; current.space = 0;
						current.total = 0;
						current.state = "data";
					} else {
						// framing error
						console.log('start bit framing error');
						current.byte = 0;
						current.state = "waiting";
						current.total = 0;
					}
				}
			},
			"data": function () {
				if (current.data ===  1) current.mark++;
				if (current.data === -1) current.space++;
				if (unit <= current.total) {
					// console.log(current);
					var bit = current.mark > current.space ? 1 : 0;
					current.mark = 0; current.space = 0;
					current.byte = current.byte | (bit<<current.bit++);
					current.total = 0;

					if (current.bit >= self.byteUnit) {
						current.bit = 0;
						current.state = "stop";
					}
				}
			},
			"stop": function () {
				if (current.data ===  1) current.mark++;
				if (current.data === -1) current.space++;
				if (unit * self.stopBit <= current.total) {
					if (current.space < current.mark) {
						callback(current.byte);
					} else {
						// framing error
						console.log('stop bit framing error');
					}
					current.mark = 0; current.space = 0;
					current.byte = 0;
					current.state = "waiting";
					current.total = 0;
				}
			}
		};

		var decoder = self.retainAudioNode(self.context.createScriptProcessor(4096, 1, 1));
		decoder.onaudioprocess = function (e) {
			var input = e.inputBuffer.getChannelData(0);
			for (var i = 0, len = e.inputBuffer.length; i < len; i += self.DOWNSAMPLE_FACTOR) { // down sample
				if (-self.threshold < input[i] && input[i] < self.threshold) {
					current.data = 0;
				} else 
				if (input[i] < 0) {
					current.data = -1;
				} else
				if (0 < input[i]) {
					current.data = 1;
				}

				states[current.state]();

				if (self.rawBitCallback) {
					self.rawBitCallback(current, input[i]);
				}

				current.total++;
			}
		};
		detection.connect(decoder);

		var outputGain = self.retainAudioNode(self.context.createGain());
		outputGain.gain.value = 0;
		decoder.connect(outputGain);
		outputGain.connect(self.context.destination);
	},

	_detectCoherent : function (source) {
		var self = this;

		var toneMark  = self.context.sampleRate / (2 * Math.PI * self.markFreq);
		var toneSpace = self.context.sampleRate / (2 * Math.PI * self.spaceFreq);

		var preFilter = self.retainAudioNode(self.context.createBiquadFilter());
		preFilter.type = 2; // band pass
		preFilter.frequency.value = Math.min(self.markFreq, self.spaceFreq) + Math.abs(self.markFreq - self.spaceFreq);
		preFilter.Q.value = 1;
		source.connect(preFilter);

		var n = 0;
		var iq = self.retainAudioNode(self.context.createScriptProcessor(4096, 1, 4));
		iq.onaudioprocess = function (e) {
			var data = e.inputBuffer.getChannelData(0);
			var outputMarkI  = e.outputBuffer.getChannelData(0);
			var outputMarkQ  = e.outputBuffer.getChannelData(1);
			var outputSpaceI = e.outputBuffer.getChannelData(2);
			var outputSpaceQ = e.outputBuffer.getChannelData(3);
			for (var i = 0, len = e.inputBuffer.length; i < len; i++) {
				outputMarkI[i]  = (Math.sin(n / toneMark)  > 0 ? 1 : -1) * data[i];
				outputMarkQ[i]  = (Math.cos(n / toneMark)  > 0 ? 1 : -1) * data[i];
				outputSpaceI[i] = (Math.sin(n / toneSpace) > 0 ? 1 : -1) * data[i];
				outputSpaceQ[i] = (Math.cos(n / toneSpace) > 0 ? 1 : -1) * data[i];
				n++;
			}
		};
		preFilter.connect(iq);

		var splitter = self.retainAudioNode(self.context.createChannelSplitter(4));
		iq.connect(splitter);
		var merger   = self.retainAudioNode(self.context.createChannelMerger(4));

		for (var i = 0; i < 4; i++) {
			var filter = self.retainAudioNode(self.context.createBiquadFilter());
			filter.type = 0; // low pass
			filter.frequency.value = self.baudrate / 2;
			filter.Q.value = 0;
			splitter.connect(filter, i, 0);
			filter.connect(merger, 0, i);
		}

		var detection = self.retainAudioNode(self.context.createScriptProcessor(4096, 4, 1));
		detection.onaudioprocess = function (e) {
			var inputMarkI  = e.inputBuffer.getChannelData(0);
			var inputMarkQ  = e.inputBuffer.getChannelData(1);
			var inputSpaceI = e.inputBuffer.getChannelData(2);
			var inputSpaceQ = e.inputBuffer.getChannelData(3);

			var outputMerged = e.outputBuffer.getChannelData(0);
			for (var i = 0, len = e.inputBuffer.length; i < len; i++) {
				var mark  = inputMarkI[i]  * inputMarkI[i]  + inputMarkQ[i]  * inputMarkQ[i];
				var space = inputSpaceI[i] * inputSpaceI[i] + inputSpaceQ[i] * inputSpaceQ[i];
				outputMerged[i] = mark - space;
			}
		};
		merger.connect(detection);

		var lpf = self.retainAudioNode(self.context.createBiquadFilter());
		lpf.type = 0; // low pass
		lpf.frequency.value = self.baudrate / 2;
		lpf.Q.value = 0;

		detection.connect(lpf);

		return lpf;
	},

	destroy : function () {
		var self = this;
		self.audioNodes = [];
	},

	retainAudioNode : function (node) {
		var self = this;
		self.audioNodes.push(node);
		return node;
	}
};


