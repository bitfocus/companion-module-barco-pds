var tcp = require('../../tcp');
var instance_skel = require('../../instance_skel');
var debug;
var log;

function instance(system, id, config) {
	var self = this;

	this.firmwareVersion = "0";
	this.firmwareVersionIsOver3 = false; // some commands are only working with firmware >= 3
	this.hasAvailInput7 = false; // not every input is available on every model
	this.hasAvailInput8 = false;
	this.hasAvailInput9 = false;
	this.hasAvailInput10 = false;
	this.hasTwoOutputs = false;

	// super-constructor
	instance_skel.apply(this, arguments);

	self.actions(); // export actions

	return self;
}

instance.prototype.updateConfig = function(config) {
	var self = this;

	debug("updateConfig() destroying and reiniting..");
	self.destroy();
	self.init();
};

instance.prototype.init = function() {
	var self = this;

	debug = self.debug;
	log = self.log;

	self.states = {};
	self.init_feedbacks();

	self.init_tcp();
};

instance.prototype.init_tcp = function() {
	var self = this;
	var receivebuffer = '';

	if (self.socket !== undefined) {
		self.socket.destroy();
		delete self.socket;
	}

	if (self.config.host) {
		self.socket = new tcp(self.config.host, 3000);

		self.socket.on('status_change', function (status, message) {
			self.status(status, message);
		});

		self.socket.on('error', function (err) {
			debug("Network error", err);
			self.log('error',"Network error: " + err.message);
		});

		self.socket.on('connect', function () {
			debug("Connected");
		});

		// separate buffered stream into lines with responses
		self.socket.on('data', function (chunk) {
			var i = 0, line = '', offset = 0;
			receivebuffer += chunk;
			while ( (i = receivebuffer.indexOf('\r', offset)) !== -1) {
				line = receivebuffer.substr(offset, i - offset);
				offset = i + 1;
				self.socket.emit('receiveline', line.toString());
			}
			receivebuffer = receivebuffer.substr(offset);
		});

		self.socket.on('receiveline', function (line) {
			debug("Received line from PDS:", line);
			// check which device and version we have
			if (line.match(/ShellApp waiting for input/)) self.socket.send(
				'\r' +
				'VER -?\r' +
				'IAVAIL -i 7 -?\r' +
				'IAVAIL -i 8 -?\r' +
				'IAVAIL -i 9 -?\r' +
				'IAVAIL -i 10-?\r' +
				'OAVAIL -o 3 -?\r' +
				'PREVIEW -?\r' +
				'PROGRAM -?\r' +
				'LOGOSEL -?\r'
			)
			if (line.match(/VER \d/)) {
				self.firmwareVersion = line.match(/VER ((?:\d+\.?)+)/)[1];
				if (parseInt(self.firmwareVersion) >= 3) self.firmwareVersionIsOver3 = true;
				debug ("version = ", self.firmwareVersion, " is over 3: ", self.firmwareVersionIsOver3);
			}
			if (line.match(/IAVAIL -i 7 -m 1/)) self.hasAvailInput7 = true;
			if (line.match(/IAVAIL -i 8 -m 1/)) self.hasAvailInput8 = true;
			if (line.match(/IAVAIL -i 9 -m 1/)) self.hasAvailInput9 = true;
			if (line.match(/IAVAIL -i 10 -m 1/)) self.hasAvailInput10 = true;
			if (line.match(/OAVAIL -o 3 -m 1/)) self.hasTwoOutputs = true;

			if (line.match(/PREVIEW -i\d+/))
			{
				self.states['preview_bg'] = parseInt(line.match(/-i(\d+)/)[1])
				self.checkFeedbacks('preview_bg')
			}
			if (line.match(/PROGRAM -i\d+/))
			{
				self.states['program_bg'] = parseInt(line.match(/-i(\d+)/)[1])
				self.checkFeedbacks('program_bg')
			}
			if (line.match(/LOGOSEL -l \d+/))
			{
				self.states['logo_bg'] = parseInt(line.match(/-l (\d+)/)[1])
				self.checkFeedbacks('logo_bg')
			}

			// Save current state preview for feedback
			if (line.match(/ISEL -i \d+/)) {
				self.states['preview_bg'] = parseInt(line.match(/-i (\d+)/)[1])
				self.checkFeedbacks('preview_bg')
			}

			// Save current state preview for feedback
			if (line.match(/TAKE -e 0/)) {
				var curPreview = self.states['preview_bg']
				self.states['preview_bg'] = self.states['program_bg']
				self.states['program_bg'] = curPreview
				self.checkFeedbacks('preview_bg')
				self.checkFeedbacks('program_bg')
			}

			if (line.match(/-e -\d+/)) {
				switch (parseInt(line.match(/-e -(\d+)/)[1])) {
					case 9999: self.log('error',"Received generic fail error from PDS "+ self.config.label +": "+ line); break;
					case 9998: self.log('error',"PDS "+ self.config.label +" says: Operation is not applicable in current state: "+ line); break;
					case 9997: self.log('error',"Received UI related error from PDS "+ self.config.label +", did not get response from device: "+ line); break;
					case 9996: self.log('error',"Received UI related error from PDS "+ self.config.label +", did not get valid response from device: "+ line); break;
					case 9995: self.log('error',"PDS "+ self.config.label +" says: Timeout occurred: "+ line); break;
					case 9994: self.log('error',"PDS "+ self.config.label +" says: Parameter / data out of range: "+ line); break;
					case 9993: self.log('error',"PDS "+ self.config.label +" says: Searching for data in an index, no matching data: "+ line); break;
					case 9992: self.log('error',"PDS "+ self.config.label +" says: Checksum didn't match: "+ line); break;
					case 9991: self.log('error',"PDS "+ self.config.label +" says: Version didn't match: "+ line); break;
					case 9990: self.log('error',"Received UI related error from PDS "+ self.config.label +", current device interface not supported: "+ line); break;
					case 9989: self.log('error',"PDS "+ self.config.label +" says: Pointer operation invalid: "+ line); break;
					case 9988: self.log('error',"PDS "+ self.config.label +" says: Part of command had error: "+ line); break;
					case 9987: self.log('error',"PDS "+ self.config.label +" says: Buffer overflow: "+ line); break;
					case 9986: self.log('error',"PDS "+ self.config.label +" says: Initialization is not done (still in progress): "+ line); break;
					default: self.log('error',"Received unspecified error from PDS "+ self.config.label +": "+ line);
				}
			}

		});

	}
};

// Return config fields for web config
instance.prototype.config_fields = function () {
	var self = this;

	return [
		{
			type: 'textinput',
			id: 'host',
			label: 'IP-Adress of PDS',
			width: 6,
			default: '192.168.0.10',
			regex: self.REGEX_IP
		},{
			type: 'dropdown',
			label: 'Variant',
			id: 'variant',
			default: '1',
			choices: self.PDS_VARIANT
		}
	]
};

// When module gets deleted
instance.prototype.destroy = function() {
	var self = this;

	if (self.socket !== undefined) {
		self.socket.destroy();
	}

	self.states = {};

	debug("destroy", self.id);
};

instance.prototype.init_feedbacks = function() {
	var self = this;
	var feedbacks = {};

	feedbacks['preview_bg'] = {
		label: 'Change colors for preview',
		description: 'If the input specified is in use by preview, change colors of the bank',
		options: [
			{
				type: 'colorpicker',
				label: 'Foreground color',
				id: 'fg',
				default: self.rgb(255,255,255)
			},
			{
				type: 'colorpicker',
				label: 'Background color',
				id: 'bg',
				default: self.rgb(0,255,0)
			},
			{
				type: 'dropdown',
				label: 'Input',
				id: 'input',
				default: 1,
				choices: self.CHOICES_INPUTS
			}
		]
	}

	feedbacks['program_bg'] = {
		label: 'Change colors for program',
		description: 'If the input specified is in use by program, change colors of the bank',
		options: [
			{
				type: 'colorpicker',
				label: 'Foreground color',
				id: 'fg',
				default: self.rgb(255,255,255)
			},
			{
				type: 'colorpicker',
				label: 'Background color',
				id: 'bg',
				default: self.rgb(255,0,0)
			},
			{
				type: 'dropdown',
				label: 'Input',
				id: 'input',
				default: 1,
				choices: self.CHOICES_INPUTS
			}
		]
	}

	feedbacks['logo_bg'] = {
		label: 'Change colors for logo',
		description: 'If the logo specified is in use, change colors of the bank',
		options: [
			{
				type: 'colorpicker',
				label: 'Foreground color',
				id: 'fg',
				default: self.rgb(255,255,255)
			},
			{
				type: 'colorpicker',
				label: 'Background color',
				id: 'bg',
				default: self.rgb(255,0,0)
			},
			{
				type: 'dropdown',
				label: 'Input',
				id: 'input',
				default: 1,
				choices: self.CHOICES_LOGOS
			}
		]
	}

	self.setFeedbackDefinitions(feedbacks);
}

instance.prototype.feedback = function(feedback, bank) {
	var self = this;

	if (feedback.type === 'program_bg') {
		if (self.states['program_bg'] === parseInt(feedback.options.input)) {
			return { color: feedback.options.fg, bgcolor: feedback.options.bg };
		}
	}

	if (feedback.type === 'preview_bg') {
		if (self.states['preview_bg'] === parseInt(feedback.options.input)) {
			return { color: feedback.options.fg, bgcolor: feedback.options.bg };
		}
	}

	if (feedback.type === 'logo_bg') {
		if (self.states['logo_bg'] === parseInt(feedback.options.input)) {
			return { color: feedback.options.fg, bgcolor: feedback.options.bg };
		}
	}

	return {};
}

instance.prototype.actions = function(system) {
	var self = this;

	self.PDS_VARIANT = [
		{ id: 1, label: 'PDS-701' },
		{ id: 2, label: 'PDS-901' },
		{ id: 3, label: 'PDS-902' }
	]

	self.CHOICES_LOGOS = [
		{id: 0, label: 'Black'},
		{id: 1, label: 'Logo 1'},
		{id: 2, label: 'Logo 2'},
		{id: 3, label: 'Logo 3'}
	]

	self.CHOICES_INPUTS = [
		{ id: 1, label: '1 VGA' },
		{ id: 2, label: '2 VGA' },
		{ id: 3, label: '3 VGA' },
		{ id: 4, label: '4 VGA' },
		{ id: 5, label: '5 DVI' },
		{ id: 6, label: '6 DVI' },
	]

	if (self.config.variant === 1 || self.config.variant === 3) {
		self.CHOICES_INPUTS.push({ id: 9, label: '9 SDI' })
	}

	if (self.config.variant >= 2) {
		self.CHOICES_INPUTS.push({ id: 7, label: '7 DVI' })
		self.CHOICES_INPUTS.push({ id: 8, label: '8 DVI' })
	}

	self.CHOICES_INPUTS.push({ id: 10, label: 'Black/Logo' })

	self.system.emit('instance_actions', self.id, {
		'TAKE': {
			label: 'Take'
			},
		'ISEL': {
			 label: 'Select Input',
			 options: [{
				type: 'dropdown',
				 label: 'Input',
				 id: 'i',
				 default: '1',
				 choices: [
					{ id: 1, label: '1 VGA' },
					{ id: 2, label: '2 VGA' },
					{ id: 3, label: '3 VGA' },
					{ id: 4, label: '4 VGA' },
					{ id: 5, label: '5 DVI' },
					{ id: 6, label: '6 DVI' },
					{ id: 7, label: '7 DVI (PDS-90x only)' },
					{ id: 8, label: '8 DVI (PDS-90x only)' },
					{ id: 9, label: '9 SDI (PDS-701/902 only)' },
					{ id: 10, label: 'Black/Logo' }
				]
				},{
				type: 'textinput',
				label: 'Filenumber (optional)',
				id: 'f',
				default: '',
				regex: '/^([1-9]|[1-5][0-9]|6[0-4])$/'
			}]},
		'FREEZE': {
			label: 'Freeze',
			options: [{
				type: 'dropdown',
				label: 'Freeze',
				id: 'm',
				default: '1',
				choices: [ { id: 0, label: 'unfrozen' }, { id: 1, label: 'frozen' } ]
			}]},
		'BLACK': {
			label: 'Set Black Output',
			options: [{
				type: 'dropdown',
				label: 'Mode',
				id: 'm',
				default: '1',
				choices: [ { id: 0, label: 'normal' }, { id: 1, label: 'black' } ]
			}]},
		'OTPM': {
			label: 'Set Testpattern on/off',
			options: [{
				type: 'dropdown',
				label: 'Output',
				id: 'o',
				default: '1',
				choices: [ { id: 1, label: 'Program' }, { id: 3, label: 'Preview' } ]
			},{
				type: 'dropdown',
				label: 'Testpattern',
				id: 'm',
				default: '1',
				choices: [ { id: 0, label: 'off' }, { id: 1, label: 'on' } ]
			}]},
		'OTPT': { label: 'Set Testpattern Type',
			options: [{
				type: 'dropdown',
				label: 'Output',
				id: 'o',
				default: '1',
				choices: [ { id: 1, label: 'Program' }, { id: 3, label: 'Preview' } ]
			},{
				type: 'dropdown',
				label: 'Type',
				id: 't',
				default: '4',
				choices: [
					{ id: 4, label: '16x16 Grid' },
					{ id: 5, label: '32x32 Grid' },
					{ id: 1, label: 'H Ramp' },
					{ id: 2, label: 'V Ramp' },
					{ id: 6, label: 'Burst' },
					{ id: 7, label: '75% Color Bars' },
					{ id: 3, label: '100% Color Bars' },
					{ id: 9, label: 'Vertical Gray Steps' },
					{ id: 10, label: 'Horizontal Gray Steps' },
					{ id: 8, label: '50% Gray' },
					{ id: 11, label: 'White' },
					{ id: 12, label: 'Black' },
					{ id: 13, label: 'Red' },
					{ id: 14, label: 'Green' },
					{ id: 15, label: 'Blue' }
				]
			}]},
		'ORBM': {
			label: 'Set Rasterbox on/off',
			options: [{
				type: 'dropdown',
				label: 'Output',
				id: 'o',
				default: '1',
				choices: [ { id: 1, label: 'Program' }, { id: 3, label: 'Preview' } ]
			},{
				type: 'dropdown',
				label: 'Rasterbox',
				id: 'm',
				default: '1',
				choices: [ { id: 0, label: 'off' }, { id: 1, label: 'on' } ]
			}]},
		'TRNTIME': { label: 'Set Transition Time',
			options: [{
				type: 'textinput',
				label: 'Seconds',
				id: 's',
				default: '1.0',
				regex: '/^([0-9]|1[0-2])(\\.\\d)?$/'
			}]},
		'LOGOSEL': {
			label: 'Select Black/Logo',
				options: [{
				type: 'dropdown',
				label: 'Framestore',
				id: 'l',
				default: '1',
				choices: [
					{ id: 0, label: 'Black' },
					{ id: 1, label: 'Logo 1' },
					{ id: 2, label: 'Logo 2' },
					{ id: 3, label: 'Logo 3' }
				]
			}]},
		'LOGOSAVE': {
			label: 'Save Logo',
				options: [{
				type: 'dropdown',
				label: 'Framestore',
				id: 'l',
				default: '1',
				choices: [
					{ id: 1, label: 'Logo 1' },
					{ id: 2, label: 'Logo 2' },
					{ id: 3, label: 'Logo 3' }
				]
			}]},
		'AUTOTAKE': {
			label: 'Set Autotake Mode on/off',
			options: [{
				type: 'dropdown',
				label: 'Autotake',
				id: 'm',
				default: '0',
				choices: [ { id: 0, label: 'off' }, { id: 1, label: 'on' } ]
			}]},
		'PENDPIP': {
			label: 'Pend PiP Mode on/off',
			options: [{
				type: 'dropdown',
				label: 'PiP',
				id: 'p',
				default: '1',
				choices: [ { id: 1, label: 'PiP 1' }, { id: 2, label: 'PiP 2' } ]
			},{
				type: 'dropdown',
				label: 'PiP on/off',
				id: 'm',
				default: '0',
				choices: [ { id: 0, label: 'unpend (no change on Take)' }, { id: 1, label: 'pend (PiP on/off on Take)' } ]
			}]},
		'PIPISEL': {
			label: 'Pend PiP Input',
			options: [{
				type: 'dropdown',
				label: 'PiP',
				id: 'p',
				default: '1',
				choices: [ { id: 0, label: 'All PiPs' }, { id: 1, label: 'PiP 1' }, { id: 2, label: 'PiP 2' } ]
			},{
				type: 'dropdown',
				 label: 'Input',
				 id: 'i',
				 default: '1',
				 choices: [
					{ id: 1, label: '1 VGA' },
					{ id: 2, label: '2 VGA' },
					{ id: 3, label: '3 VGA' },
					{ id: 4, label: '4 VGA' },
					{ id: 5, label: '5 DVI' },
					{ id: 6, label: '6 DVI' },
					{ id: 7, label: '7 DVI (PDS-90x only)' },
					{ id: 8, label: '8 DVI (PDS-90x only)' },
					{ id: 9, label: '9 SDI (PDS-701/902 only)' },
					{ id: 10, label: 'Black/Logo' }
				]
			}]},

	});
}

instance.prototype.action = function(action) {
	var self = this;

	var cmd = action.action;
	for (var option in action.options) {
		if (action.options.hasOwnProperty(option) && action.options[option] != '') cmd += " -" + option + " " + action.options[option];
	}
	cmd +="\r";

	if (cmd !== undefined) {

		debug('sending tcp',cmd,"to",self.config.host);

		if (self.socket !== undefined && self.socket.connected) {
			self.socket.send(cmd);
		} else {
			debug('Socket not connected :(');
		}


	}
	
};

instance_skel.extendedBy(instance);
exports = module.exports = instance;
