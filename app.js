class SimpleRaveEngine {
    constructor(app) {
        this.app = app;
        this.audioContext = null;
        this.masterGain = null;
        this.delayNode = null;
        this.feedbackGain = null;
        this.filterNode = null;
        this.reverbNode = null;
        this.reverbGain = null;
        this.mediaDestination = null;
        this.analyserNode = null;
        this.meterData = null;
        this.schedulerId = null;
        this.nextStepTime = 0;
        this.stepIndex = 0;
        this.isRunning = false;
        this.noiseBuffer = null;
        this.activeNodes = new Set();
        this.trackBuses = {};
    }

    async ensureAudioContext() {
        if (!this.audioContext) {
            const Context = window.AudioContext || window.webkitAudioContext;
            this.audioContext = new Context();

            this.masterGain = this.audioContext.createGain();
            this.analyserNode = this.audioContext.createAnalyser();
            this.filterNode = this.audioContext.createBiquadFilter();
            this.filterNode.type = 'lowpass';
            this.delayNode = this.audioContext.createDelay(0.6);
            this.feedbackGain = this.audioContext.createGain();
            this.reverbNode = this.audioContext.createConvolver();
            this.reverbGain = this.audioContext.createGain();
            this.mediaDestination = this.audioContext.createMediaStreamDestination();

            this.analyserNode.fftSize = 256;
            this.analyserNode.smoothingTimeConstant = 0.72;
            this.meterData = new Uint8Array(this.analyserNode.fftSize);

            this.masterGain.connect(this.analyserNode);
            this.analyserNode.connect(this.filterNode);
            this.filterNode.connect(this.delayNode);
            this.filterNode.connect(this.audioContext.destination);
            this.filterNode.connect(this.mediaDestination);
            this.filterNode.connect(this.reverbNode);
            this.reverbNode.connect(this.reverbGain);
            this.reverbGain.connect(this.audioContext.destination);
            this.reverbGain.connect(this.mediaDestination);
            this.delayNode.connect(this.feedbackGain);
            this.feedbackGain.connect(this.delayNode);
            this.delayNode.connect(this.audioContext.destination);
            this.delayNode.connect(this.mediaDestination);

            this.noiseBuffer = this.createNoiseBuffer();
            this.reverbNode.buffer = this.createReverbImpulse();
            this.ensureTrackBuses();
        }

        if (this.audioContext.state !== 'running') {
            await this.audioContext.resume();
        }

        this.syncMix();
    }

    createNoiseBuffer() {
        const buffer = this.audioContext.createBuffer(1, this.audioContext.sampleRate * 2, this.audioContext.sampleRate);
        const data = buffer.getChannelData(0);

        for (let index = 0; index < data.length; index += 1) {
            data[index] = Math.random() * 2 - 1;
        }

        return buffer;
    }

    createReverbImpulse() {
        const length = this.audioContext.sampleRate * 1.8;
        const impulse = this.audioContext.createBuffer(2, length, this.audioContext.sampleRate);

        for (let channelIndex = 0; channelIndex < impulse.numberOfChannels; channelIndex += 1) {
            const channelData = impulse.getChannelData(channelIndex);
            for (let index = 0; index < length; index += 1) {
                const decay = Math.pow(1 - index / length, 2.6);
                channelData[index] = (Math.random() * 2 - 1) * decay;
            }
        }

        return impulse;
    }

    ensureTrackBuses() {
        Object.keys(this.app.trackStates).forEach((trackId) => {
            if (this.trackBuses[trackId]) {
                return;
            }

            const input = this.audioContext.createGain();
            const pan = this.audioContext.createStereoPanner();
            const output = this.audioContext.createGain();

            input.connect(pan);
            pan.connect(output);
            output.connect(this.masterGain);

            this.trackBuses[trackId] = { input, pan, output };
        });
    }

    getTrackBus(trackId) {
        if (!this.audioContext) {
            return null;
        }

        if (!this.trackBuses[trackId]) {
            this.ensureTrackBuses();
        }

        return this.trackBuses[trackId];
    }

    syncTrackBuses() {
        if (!this.audioContext) {
            return;
        }

        const now = this.audioContext.currentTime;
        const anySolo = Object.values(this.app.trackStates).some((track) => track.solo);

        Object.entries(this.app.trackStates).forEach(([trackId, trackState]) => {
            const bus = this.getTrackBus(trackId);
            if (!bus) {
                return;
            }

            const gate = trackState.muted || (anySolo && !trackState.solo) ? 0 : 1;
            const volume = Math.max(0, Math.min(1, Number(trackState.volume) || 0));
            const pan = Math.max(-1, Math.min(1, Number(trackState.pan) || 0));

            bus.output.gain.setTargetAtTime(volume * gate, now, 0.02);
            bus.pan.pan.setTargetAtTime(pan, now, 0.02);
        });
    }

    syncMix() {
        if (!this.audioContext) {
            return;
        }

        const { masterVolume, delay, filter, reverb } = this.app.globalEffects;
        const now = this.audioContext.currentTime;

        this.masterGain.gain.setTargetAtTime(masterVolume, now, 0.02);
        this.delayNode.delayTime.setTargetAtTime(Math.max(0.08, delay * 0.45), now, 0.02);
        this.feedbackGain.gain.setTargetAtTime(Math.min(0.55, delay * 0.5), now, 0.02);
        this.filterNode.frequency.setTargetAtTime(800 + filter * 8000, now, 0.02);
        this.reverbGain.gain.setTargetAtTime(reverb * 0.6, now, 0.02);
        this.syncTrackBuses();
    }

    trackLevel(trackId) {
        const track = this.app.trackStates[trackId];
        if (!track) {
            return 0;
        }

        const anySolo = Object.values(this.app.trackStates).some((candidate) => candidate.solo);
        if (track.muted || (anySolo && !track.solo)) {
            return 0;
        }

        return 1;
    }

    scheduleEnvelope(gainNode, time, attack, peak, decay) {
        gainNode.gain.cancelScheduledValues(time);
        gainNode.gain.setValueAtTime(0.0001, time);
        gainNode.gain.linearRampToValueAtTime(peak, time + attack);
        gainNode.gain.exponentialRampToValueAtTime(0.0001, time + attack + decay);
    }

    registerNode(node, stopTime) {
        this.activeNodes.add(node);
        node.onended = () => {
            this.activeNodes.delete(node);
            try {
                node.disconnect();
            } catch (_) {
                // ignore disconnect races
            }
        };
        node.stop(stopTime);
    }

    scheduleKick(time) {
        const level = this.trackLevel('kick');
        if (level <= 0) {
            return;
        }

        const osc = this.audioContext.createOscillator();
        const gain = this.audioContext.createGain();

        osc.type = 'sine';
        osc.frequency.setValueAtTime(150, time);
        osc.frequency.exponentialRampToValueAtTime(42, time + 0.18);
        gain.gain.setValueAtTime(0.0001, time);
        gain.gain.linearRampToValueAtTime(0.95 * level, time + 0.002);
        gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.22);

        osc.connect(gain);
        gain.connect(this.getTrackBus('kick').input);
        osc.start(time);
        this.registerNode(osc, time + 0.24);
    }

    scheduleHat(time, open = false) {
        const level = this.trackLevel('percussion');
        if (level <= 0) {
            return;
        }

        const source = this.audioContext.createBufferSource();
        source.buffer = this.noiseBuffer;

        const filter = this.audioContext.createBiquadFilter();
        filter.type = 'highpass';
        filter.frequency.value = open ? 6500 : 9000;

        const gain = this.audioContext.createGain();
        this.scheduleEnvelope(gain, time, 0.001, (open ? 0.22 : 0.12) * level, open ? 0.22 : 0.06);

        source.connect(filter);
        filter.connect(gain);
        gain.connect(this.getTrackBus('percussion').input);
        source.start(time);
        this.registerNode(source, time + (open ? 0.26 : 0.09));
    }

    scheduleSnare(time) {
        const level = this.trackLevel('mainbreak');
        if (level <= 0) {
            return;
        }

        const source = this.audioContext.createBufferSource();
        source.buffer = this.noiseBuffer;

        const filter = this.audioContext.createBiquadFilter();
        filter.type = 'bandpass';
        filter.frequency.value = 1800;
        filter.Q.value = 0.8;

        const bodyOsc = this.audioContext.createOscillator();
        bodyOsc.type = 'triangle';
        bodyOsc.frequency.setValueAtTime(240, time);
        bodyOsc.frequency.exponentialRampToValueAtTime(120, time + 0.12);

        const noiseGain = this.audioContext.createGain();
        const bodyGain = this.audioContext.createGain();

        this.scheduleEnvelope(noiseGain, time, 0.001, 0.22 * level, 0.16);
        this.scheduleEnvelope(bodyGain, time, 0.001, 0.18 * level, 0.14);

        source.connect(filter);
        filter.connect(noiseGain);
        bodyOsc.connect(bodyGain);
        noiseGain.connect(this.getTrackBus('mainbreak').input);
        bodyGain.connect(this.getTrackBus('mainbreak').input);

        source.start(time);
        bodyOsc.start(time);
        this.registerNode(source, time + 0.18);
        this.registerNode(bodyOsc, time + 0.16);
    }

    scheduleBass(time, midi) {
        const level = this.trackLevel('bass');
        if (level <= 0) {
            return;
        }

        const osc = this.audioContext.createOscillator();
        const sub = this.audioContext.createOscillator();
        const filter = this.audioContext.createBiquadFilter();
        const gain = this.audioContext.createGain();
        const frequency = 440 * Math.pow(2, (midi - 69) / 12);

        osc.type = 'sawtooth';
        sub.type = 'sine';
        filter.type = 'lowpass';
        filter.frequency.value = 320;
        filter.Q.value = 1.2;
        osc.frequency.setValueAtTime(frequency, time);
        sub.frequency.setValueAtTime(frequency / 2, time);

        gain.gain.setValueAtTime(0.0001, time);
        gain.gain.linearRampToValueAtTime(0.28 * level, time + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.42);

        osc.connect(filter);
        sub.connect(filter);
        filter.connect(gain);
        gain.connect(this.getTrackBus('bass').input);

        osc.start(time);
        sub.start(time);
        this.registerNode(osc, time + 0.45);
        this.registerNode(sub, time + 0.45);
    }

    scheduleChord(time, midiNotes) {
        const level = this.trackLevel('stabs');
        if (level <= 0) {
            return;
        }

        midiNotes.forEach((midi, index) => {
            const osc = this.audioContext.createOscillator();
            const gain = this.audioContext.createGain();
            const filter = this.audioContext.createBiquadFilter();
            const frequency = 440 * Math.pow(2, (midi - 69) / 12);

            osc.type = index === 0 ? 'square' : 'sawtooth';
            osc.frequency.setValueAtTime(frequency, time);
            filter.type = 'bandpass';
            filter.frequency.value = 1200 + index * 150;
            filter.Q.value = 1.3;

            gain.gain.setValueAtTime(0.0001, time);
            gain.gain.linearRampToValueAtTime((0.11 / midiNotes.length) * level, time + 0.004);
            gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.32);

            osc.connect(filter);
            filter.connect(gain);
            gain.connect(this.getTrackBus('stabs').input);
            osc.start(time);
            this.registerNode(osc, time + 0.34);
        });
    }

    scheduleLead(time, midi) {
        const level = this.trackLevel('lead');
        if (level <= 0) {
            return;
        }

        const osc = this.audioContext.createOscillator();
        const gain = this.audioContext.createGain();
        const filter = this.audioContext.createBiquadFilter();
        const frequency = 440 * Math.pow(2, (midi - 69) / 12);

        osc.type = 'triangle';
        osc.frequency.setValueAtTime(frequency, time);
        osc.frequency.setValueAtTime(frequency * 1.005, time + 0.08);
        filter.type = 'lowpass';
        filter.frequency.value = 2600;

        gain.gain.setValueAtTime(0.0001, time);
        gain.gain.linearRampToValueAtTime(0.12 * level, time + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.22);

        osc.connect(filter);
        filter.connect(gain);
        gain.connect(this.getTrackBus('lead').input);

        osc.start(time);
        this.registerNode(osc, time + 0.24);
    }

    getLanePlaybackBuffer(laneId) {
        const lane = this.app.sampleState[laneId];
        if (!lane) {
            return null;
        }

        if (lane.reverse && lane.reverseBuffer) {
            return lane.reverseBuffer;
        }

        return lane.buffer || null;
    }

    scheduleVocalPulse(time) {
        const level = this.trackLevel('vocal');
        if (level <= 0) {
            return;
        }

        const vocalSample = this.app.sampleState.vocal;

        if (this.getLanePlaybackBuffer('vocal')) {
            const source = this.audioContext.createBufferSource();
            const filter = this.audioContext.createBiquadFilter();
            const gain = this.audioContext.createGain();
            const playbackBuffer = this.getLanePlaybackBuffer('vocal');
            const startPoint = playbackBuffer.duration * vocalSample.start;
            const endPoint = playbackBuffer.duration * vocalSample.end;
            const duration = Math.max(0.05, endPoint - startPoint);

            source.buffer = playbackBuffer;
            source.playbackRate.setValueAtTime(vocalSample.rate, time);
            filter.type = 'bandpass';
            filter.frequency.value = 1400;
            filter.Q.value = 1.2;

            gain.gain.setValueAtTime(0.0001, time);
            gain.gain.linearRampToValueAtTime(0.42 * level, time + 0.01);
            gain.gain.exponentialRampToValueAtTime(0.0001, time + Math.min(duration, 0.48));

            source.connect(filter);
            filter.connect(gain);
            gain.connect(this.getTrackBus('vocal').input);
            source.start(time, startPoint, duration);
            this.registerNode(source, time + duration + 0.02);
            return;
        }

        const source = this.audioContext.createBufferSource();
        source.buffer = this.noiseBuffer;

        const filter = this.audioContext.createBiquadFilter();
        filter.type = 'bandpass';
        filter.frequency.value = 900;
        filter.Q.value = 8;

        const gain = this.audioContext.createGain();
        this.scheduleEnvelope(gain, time, 0.002, 0.16 * level, 0.2);

        source.connect(filter);
        filter.connect(gain);
        gain.connect(this.getTrackBus('vocal').input);
        source.start(time);
        this.registerNode(source, time + 0.22);
    }

    scheduleFxPulse(time) {
        const level = this.trackLevel('fx');
        if (level <= 0) {
            return;
        }

        const fxSample = this.app.sampleState.fx;

        if (this.getLanePlaybackBuffer('fx')) {
            const source = this.audioContext.createBufferSource();
            const filter = this.audioContext.createBiquadFilter();
            const gain = this.audioContext.createGain();
            const playbackBuffer = this.getLanePlaybackBuffer('fx');
            const startPoint = playbackBuffer.duration * fxSample.start;
            const endPoint = playbackBuffer.duration * fxSample.end;
            const duration = Math.max(0.05, endPoint - startPoint);

            source.buffer = playbackBuffer;
            source.playbackRate.setValueAtTime(fxSample.rate, time);
            filter.type = 'highpass';
            filter.frequency.value = 1200;
            filter.Q.value = 0.8;

            gain.gain.setValueAtTime(0.0001, time);
            gain.gain.linearRampToValueAtTime(0.36 * level, time + 0.01);
            gain.gain.exponentialRampToValueAtTime(0.0001, time + Math.min(duration, 0.52));

            source.connect(filter);
            filter.connect(gain);
            gain.connect(this.getTrackBus('fx').input);
            source.start(time, startPoint, duration);
            this.registerNode(source, time + duration + 0.02);
            return;
        }

        const osc = this.audioContext.createOscillator();
        const filter = this.audioContext.createBiquadFilter();
        const gain = this.audioContext.createGain();

        osc.type = 'square';
        osc.frequency.setValueAtTime(780, time);
        osc.frequency.exponentialRampToValueAtTime(340, time + 0.18);
        filter.type = 'bandpass';
        filter.frequency.value = 1650;
        filter.Q.value = 2.4;

        gain.gain.setValueAtTime(0.0001, time);
        gain.gain.linearRampToValueAtTime(0.14 * level, time + 0.003);
        gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.2);

        osc.connect(filter);
        filter.connect(gain);
        gain.connect(this.getTrackBus('fx').input);
        osc.start(time);
        this.registerNode(osc, time + 0.22);
    }

    scheduleTexturePulse(time) {
        const level = this.trackLevel('texture');
        if (level <= 0) {
            return;
        }

        const textureSample = this.app.sampleState.texture;

        if (this.getLanePlaybackBuffer('texture')) {
            const source = this.audioContext.createBufferSource();
            const filter = this.audioContext.createBiquadFilter();
            const gain = this.audioContext.createGain();
            const playbackBuffer = this.getLanePlaybackBuffer('texture');
            const startPoint = playbackBuffer.duration * textureSample.start;
            const endPoint = playbackBuffer.duration * textureSample.end;
            const duration = Math.max(0.08, endPoint - startPoint);

            source.buffer = playbackBuffer;
            source.playbackRate.setValueAtTime(textureSample.rate, time);
            filter.type = 'bandpass';
            filter.frequency.value = 2200;
            filter.Q.value = 0.75;

            gain.gain.setValueAtTime(0.0001, time);
            gain.gain.linearRampToValueAtTime(0.28 * level, time + 0.02);
            gain.gain.exponentialRampToValueAtTime(0.0001, time + Math.min(duration, 0.72));

            source.connect(filter);
            filter.connect(gain);
            gain.connect(this.getTrackBus('texture').input);
            source.start(time, startPoint, duration);
            this.registerNode(source, time + duration + 0.02);
            return;
        }

        const source = this.audioContext.createBufferSource();
        source.buffer = this.noiseBuffer;

        const filter = this.audioContext.createBiquadFilter();
        filter.type = 'bandpass';
        filter.frequency.value = 2600;
        filter.Q.value = 1.1;

        const gain = this.audioContext.createGain();
        this.scheduleEnvelope(gain, time, 0.03, 0.12 * level, 0.46);

        source.connect(filter);
        filter.connect(gain);
        gain.connect(this.getTrackBus('texture').input);
        source.start(time);
        this.registerNode(source, time + 0.52);
    }

    schedulePercPulse(time) {
        const level = this.trackLevel('percshot');
        if (level <= 0) {
            return;
        }

        const percSample = this.app.sampleState.perc;

        if (this.getLanePlaybackBuffer('perc')) {
            const source = this.audioContext.createBufferSource();
            const filter = this.audioContext.createBiquadFilter();
            const gain = this.audioContext.createGain();
            const playbackBuffer = this.getLanePlaybackBuffer('perc');
            const startPoint = playbackBuffer.duration * percSample.start;
            const endPoint = playbackBuffer.duration * percSample.end;
            const duration = Math.max(0.03, endPoint - startPoint);

            source.buffer = playbackBuffer;
            source.playbackRate.setValueAtTime(percSample.rate, time);
            filter.type = 'highpass';
            filter.frequency.value = 3600;
            filter.Q.value = 0.7;

            gain.gain.setValueAtTime(0.0001, time);
            gain.gain.linearRampToValueAtTime(0.32 * level, time + 0.002);
            gain.gain.exponentialRampToValueAtTime(0.0001, time + Math.min(duration, 0.18));

            source.connect(filter);
            filter.connect(gain);
            gain.connect(this.getTrackBus('percshot').input);
            source.start(time, startPoint, duration);
            this.registerNode(source, time + duration + 0.02);
            return;
        }

        const osc = this.audioContext.createOscillator();
        const filter = this.audioContext.createBiquadFilter();
        const gain = this.audioContext.createGain();

        osc.type = 'triangle';
        osc.frequency.setValueAtTime(1200, time);
        osc.frequency.exponentialRampToValueAtTime(620, time + 0.08);
        filter.type = 'highpass';
        filter.frequency.value = 4200;
        filter.Q.value = 0.9;

        gain.gain.setValueAtTime(0.0001, time);
        gain.gain.linearRampToValueAtTime(0.16 * level, time + 0.001);
        gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.08);

        osc.connect(filter);
        filter.connect(gain);
        gain.connect(this.getTrackBus('percshot').input);
        osc.start(time);
        this.registerNode(osc, time + 0.1);
    }

    scheduleStep(step, time) {
        const bassPattern = [37, null, 37, null, 42, null, 42, null, 44, null, 44, null, 49, null, 49, null];
        const leadPattern = [61, null, null, 64, null, 66, null, 68, 69, null, 68, null, 66, null, 64, null];
        const chordPattern = {
            0: [61, 65, 68],
            4: [61, 65, 68],
            8: [66, 70, 73],
            12: [68, 73, 76]
        };

        if (this.app.sequenceConfig.kickSteps.includes(step + 1)) {
            this.scheduleKick(time);
        }
        if (this.app.sequenceConfig.snareSteps.includes(step + 1)) {
            this.scheduleSnare(time);
        }
        if (this.app.sequenceConfig.hatSteps.includes(step + 1)) {
            this.scheduleHat(time, (step + 1) % 4 === 0);
        }

        if (bassPattern[step] !== null) {
            this.scheduleBass(time, bassPattern[step]);
        }

        if (chordPattern[step]) {
            this.scheduleChord(time, chordPattern[step]);
        }

        if (leadPattern[step] !== null) {
            this.scheduleLead(time, leadPattern[step]);
        }

        if (this.app.sequenceConfig.vocalSteps.includes(step + 1)) {
            this.scheduleVocalPulse(time);
        }

        if (this.app.sequenceConfig.fxSteps.includes(step + 1)) {
            this.scheduleFxPulse(time);
        }

        if (this.app.sequenceConfig.textureSteps.includes(step + 1)) {
            this.scheduleTexturePulse(time);
        }

        if (this.app.sequenceConfig.percSteps.includes(step + 1)) {
            this.schedulePercPulse(time);
        }
    }

    scheduler() {
        const scheduleAheadTime = 0.12;

        while (this.nextStepTime < this.audioContext.currentTime + scheduleAheadTime) {
            this.scheduleStep(this.stepIndex % 16, this.nextStepTime);

            const stepDuration = 60 / this.app.globalEffects.tempo / 4;
            this.nextStepTime += stepDuration;
            this.stepIndex += 1;
        }
    }

    async start() {
        await this.ensureAudioContext();

        this.stop();
        this.isRunning = true;
        this.stepIndex = 0;
        this.nextStepTime = this.audioContext.currentTime + 0.05;

        this.schedulerId = window.setInterval(() => this.scheduler(), 25);
        this.scheduler();
    }

    stop() {
        this.isRunning = false;

        if (this.schedulerId) {
            clearInterval(this.schedulerId);
            this.schedulerId = null;
        }

        this.activeNodes.forEach((node) => {
            try {
                node.stop();
            } catch (_) {
                // node may already be stopped
            }
        });
        this.activeNodes.clear();
    }

    getRecordingStream() {
        return this.mediaDestination?.stream || null;
    }

    getMeterLevel() {
        if (!this.analyserNode || !this.meterData) {
            return 0;
        }

        this.analyserNode.getByteTimeDomainData(this.meterData);
        const sumSquares = this.meterData.reduce((sum, value) => {
            const normalized = (value - 128) / 128;
            return sum + (normalized * normalized);
        }, 0);
        const rms = Math.sqrt(sumSquares / this.meterData.length);
        return Math.max(0, Math.min(1, rms * 2.8));
    }

    async playAudioCheckTone() {
        await this.ensureAudioContext();
        const startTime = this.audioContext.currentTime + 0.02;
        const oscillator = this.audioContext.createOscillator();
        const gain = this.audioContext.createGain();

        oscillator.type = 'sine';
        oscillator.frequency.setValueAtTime(440, startTime);
        oscillator.frequency.exponentialRampToValueAtTime(660, startTime + 0.32);

        gain.gain.setValueAtTime(0.0001, startTime);
        gain.gain.linearRampToValueAtTime(0.14, startTime + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, startTime + 0.42);

        oscillator.connect(gain);
        gain.connect(this.audioContext.destination);
        gain.connect(this.mediaDestination);

        oscillator.onended = () => {
            try {
                oscillator.disconnect();
                gain.disconnect();
            } catch (_) {
                // ignore cleanup races
            }
        };

        oscillator.start(startTime);
        oscillator.stop(startTime + 0.46);
    }
}

class ProdigyStrudelApp {
    constructor() {
        this.isPlaying = false;
        this.currentTime = 0;
        this.totalTime = 213;
        this.currentCycle = 0;
        this.currentBeat = 1;
        this.updateInterval = null;
        this.beatInterval = null;
        this.codeEditorVisible = false;
        this.workspaceLayout = 'studio';
        this.assistantVisible = false;
        this.interfaceMode = 'simple';
        this.advancedTab = 'arrange';
        this.consoleDrawerTab = 'projects';
        this.strudelReady = false;
        this.userHasCustomCode = false;
        this.isRecording = false;
        this.mediaRecorder = null;
        this.recordedChunks = [];
        this.recordingMimeType = '';
        this.activeScene = 'main';
        this.pendingInstallPrompt = null;
        this.projectLibrary = [];
        this.projectDbPromise = null;
        this.assistantMessages = [];
        this.assistantBusy = false;
        this.recordingOptions = {
            takeLabel: 'untitled-session',
            autoStopAtEnd: true
        };

        this.trackStates = this.createDefaultTrackStates();

        this.globalEffects = this.createDefaultGlobalEffects();

        this.rhythmPresets = {
            'club-drive': {
                label: 'Club Drive',
                kickSteps: [1, 5, 9, 13],
                snareSteps: [5, 13],
                hatSteps: [1, 3, 5, 7, 9, 11, 13, 15]
            },
            'break-swing': {
                label: 'Break Swing',
                kickSteps: [1, 4, 9, 11, 13],
                snareSteps: [5, 8, 13, 16],
                hatSteps: [1, 2, 4, 6, 7, 9, 10, 12, 14, 15]
            },
            'half-time': {
                label: 'Half-Time',
                kickSteps: [1, 7, 9, 15],
                snareSteps: [9],
                hatSteps: [1, 3, 5, 7, 9, 11, 13, 15]
            }
        };

        this.scenePresets = {
            intro: {
                label: 'Intro',
                description: 'Sparse opening with light percussion, a distant stab bed, and a late vocal teaser.',
                globalEffects: { filter: 0.32, delay: 0.18, reverb: 0.36 },
                trackStates: {
                    mainbreak: { volume: 0.58, muted: false },
                    kick: { volume: 0.44, muted: false },
                    bass: { volume: 0.55, muted: true },
                    stabs: { volume: 0.28, muted: false },
                    lead: { volume: 0.3, muted: true },
                    vocal: { volume: 0.72, muted: false },
                    fx: { volume: 0.3, muted: true },
                    percussion: { volume: 0.32, muted: false },
                    texture: { volume: 0.42, muted: false },
                    percshot: { volume: 0.24, muted: true }
                },
                sequenceConfig: { kickSteps: [1, 9], snareSteps: [13], hatSteps: [1, 5, 9, 13], vocalSteps: [16], fxSteps: [], textureSteps: [1, 9], percSteps: [15] }
            },
            main: {
                label: 'Main',
                description: 'Full groove with the core rave pulse, broad drum energy, and the standard vocal call-outs.',
                globalEffects: { filter: 0.5, delay: 0.25, reverb: 0.3 },
                trackStates: {
                    mainbreak: { volume: 0.9, muted: false },
                    kick: { volume: 0.8, muted: false },
                    bass: { volume: 0.7, muted: false },
                    stabs: { volume: 0.6, muted: false },
                    lead: { volume: 0.5, muted: false },
                    vocal: { volume: 0.8, muted: false },
                    fx: { volume: 0.55, muted: false },
                    percussion: { volume: 0.5, muted: false },
                    texture: { volume: 0.42, muted: false },
                    percshot: { volume: 0.38, muted: false }
                },
                sequenceConfig: { kickSteps: [1, 5, 9, 13], snareSteps: [5, 13], hatSteps: [1, 3, 5, 7, 9, 11, 13, 15], vocalSteps: [8, 16], fxSteps: [4, 12], textureSteps: [1, 9], percSteps: [3, 7, 11, 15] }
            },
            breakdown: {
                label: 'Breakdown',
                description: 'Pulls back the drums, opens more atmosphere, and leaves room for chopped vocal fragments.',
                globalEffects: { filter: 0.26, delay: 0.42, reverb: 0.48 },
                trackStates: {
                    mainbreak: { volume: 0.4, muted: true },
                    kick: { volume: 0.32, muted: true },
                    bass: { volume: 0.48, muted: false },
                    stabs: { volume: 0.44, muted: false },
                    lead: { volume: 0.38, muted: false },
                    vocal: { volume: 0.86, muted: false },
                    fx: { volume: 0.44, muted: false },
                    percussion: { volume: 0.26, muted: true },
                    texture: { volume: 0.56, muted: false },
                    percshot: { volume: 0.16, muted: true }
                },
                sequenceConfig: { kickSteps: [1, 11], snareSteps: [9], hatSteps: [1, 5, 9, 13], vocalSteps: [4, 8, 12, 16], fxSteps: [12], textureSteps: [1, 5, 9, 13], percSteps: [] }
            },
            build: {
                label: 'Build',
                description: 'Builds pressure with denser vocal chops, a brighter filter, and more forward percussion.',
                globalEffects: { filter: 0.68, delay: 0.33, reverb: 0.28 },
                trackStates: {
                    mainbreak: { volume: 0.78, muted: false },
                    kick: { volume: 0.72, muted: false },
                    bass: { volume: 0.76, muted: false },
                    stabs: { volume: 0.66, muted: false },
                    lead: { volume: 0.62, muted: false },
                    vocal: { volume: 0.88, muted: false },
                    fx: { volume: 0.62, muted: false },
                    percussion: { volume: 0.6, muted: false },
                    texture: { volume: 0.54, muted: false },
                    percshot: { volume: 0.42, muted: false }
                },
                sequenceConfig: { kickSteps: [1, 5, 7, 9, 13, 15], snareSteps: [5, 13], hatSteps: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16], vocalSteps: [4, 8, 12, 14, 16], fxSteps: [8, 12, 16], textureSteps: [4, 12], percSteps: [2, 6, 10, 14] }
            },
            climax: {
                label: 'Climax',
                description: 'Maximum energy: all layers up, open filter, heavy break support, and repeated vocal hits.',
                globalEffects: { filter: 0.82, delay: 0.29, reverb: 0.24 },
                trackStates: {
                    mainbreak: { volume: 0.96, muted: false },
                    kick: { volume: 0.88, muted: false },
                    bass: { volume: 0.82, muted: false },
                    stabs: { volume: 0.72, muted: false },
                    lead: { volume: 0.7, muted: false },
                    vocal: { volume: 0.92, muted: false },
                    fx: { volume: 0.74, muted: false },
                    percussion: { volume: 0.66, muted: false },
                    texture: { volume: 0.48, muted: false },
                    percshot: { volume: 0.44, muted: false }
                },
                sequenceConfig: { kickSteps: [1, 5, 9, 11, 13, 15], snareSteps: [5, 8, 13, 16], hatSteps: [1, 2, 4, 6, 7, 8, 9, 10, 12, 14, 15, 16], vocalSteps: [2, 4, 8, 10, 12, 16], fxSteps: [4, 8, 12, 16], textureSteps: [8, 16], percSteps: [3, 7, 11, 15] }
            },
            outro: {
                label: 'Outro',
                description: 'A controlled landing with lighter drums and a final vocal echo before the track drops away.',
                globalEffects: { filter: 0.36, delay: 0.39, reverb: 0.42 },
                trackStates: {
                    mainbreak: { volume: 0.42, muted: false },
                    kick: { volume: 0.36, muted: false },
                    bass: { volume: 0.5, muted: false },
                    stabs: { volume: 0.24, muted: false },
                    lead: { volume: 0.22, muted: true },
                    vocal: { volume: 0.72, muted: false },
                    fx: { volume: 0.22, muted: true },
                    percussion: { volume: 0.24, muted: false },
                    texture: { volume: 0.4, muted: false },
                    percshot: { volume: 0.18, muted: true }
                },
                sequenceConfig: { kickSteps: [1, 9], snareSteps: [13], hatSteps: [1, 5, 9, 13], vocalSteps: [8, 16], fxSteps: [16], textureSteps: [9, 16], percSteps: [] }
            }
        };

        this.sceneStyles = {
            intro: { color: '#17d3a4', glow: 'rgba(23, 211, 164, 0.35)' },
            main: { color: '#ff4f94', glow: 'rgba(255, 79, 148, 0.35)' },
            breakdown: { color: '#4ca7ff', glow: 'rgba(76, 167, 255, 0.35)' },
            build: { color: '#ffb347', glow: 'rgba(255, 179, 71, 0.35)' },
            climax: { color: '#ff5f5f', glow: 'rgba(255, 95, 95, 0.35)' },
            outro: { color: '#b188ff', glow: 'rgba(177, 136, 255, 0.35)' }
        };

        this.sequenceConfig = this.createDefaultSequenceConfig();

        this.arrangement = this.createDefaultArrangement();

        this.exampleLibrary = [
            {
                id: 'breakbeat-foundation',
                name: 'Breakbeat Foundation',
                description: 'A fast sketch with kick support, hats, and a simple acid bass pulse.',
                code: `stack(
  s("bd*4"),
  s("hh*8").gain(0.45),
  note("c2 c2 fs2 fs2 g#2 g#2 c3 c3").s("sawtooth").gain(0.28)
)
  .lpf(2600)
  .room(0.22)
  .delay(0.15)
  .cpm(32.75)`
            },
            {
                id: 'rave-stabs',
                name: 'Rave Stabs',
                description: 'Bright stab chords and a lead line that feel instantly old-school rave.',
                code: `stack(
  note("<[cs4,f4,gs4] ~ [cs4,f4,gs4] ~ [fs4,a4,cs5] ~ [gs4,cs5,ds5] ~>").s("square").gain(0.24),
  note("cs5 ~ e5 ~ fs5 ~ gs5 ~ a5 ~ gs5 ~ fs5 ~ e5 ~").s("triangle").gain(0.18)
)
  .lpf(3400)
  .room(0.3)
  .delay(0.22)
  .cpm(35)`
            },
            {
                id: 'full-arrangement',
                name: 'Full Arrangement Skeleton',
                description: 'A longer coded sketch that mirrors an intro, drop, breakdown, build, and return.',
                code: `let intro = stack(
  s("bd ~ ~ ~"),
  s("hh*4").gain(0.2)
)

let main = stack(
  s("bd*4"),
  s("hh*8").gain(0.45),
  note("c2 c2 fs2 fs2 g#2 g#2 c3 c3").s("sawtooth").gain(0.25)
)

let breakdown = stack(
  note("c2 ~ g1 ~").s("sawtooth").gain(0.18),
  note("<[cs4,f4,gs4] ~ [fs4,a4,cs5] ~>").s("square").gain(0.16)
)

arrange(
  [8, intro],
  [16, main],
  [8, breakdown],
  [8, main.fast(2)]
)
  .room(0.28)
  .delay(0.2)
  .cpm(32.75)`
            },
            {
                id: 'vocal-chops',
                name: 'Vocal Chop Sketch',
                description: 'A short pattern designed to be paired with imported vocal slices and quick repeats.',
                code: `stack(
  s("bd*4"),
  s("hh*8").gain(0.4),
  s("cp ~ cp cp").gain(0.2)
)
  .sometimesBy(0.3, rev)
  .delay(0.18)
  .room(0.24)
  .cpm(32.75)

// Pair this with the local vocal sampler in the Studio controls.`
            },
            {
                id: 'hardcore-rise',
                name: 'Hardcore Rise',
                description: 'A more intense section with faster hats and heavier lead energy for the climax.',
                code: `stack(
  s("bd*4").gain(1),
  s("hh*16").gain(0.38),
  note("c2 c2 fs2 fs2 g#2 g#2 c3 c3").s("sawtooth").gain(0.3),
  note("cs5 e5 fs5 gs5 a5 gs5 fs5 e5").s("triangle").gain(0.22)
)
  .lpf(4200)
  .delay(0.24)
  .room(0.18)
  .gain(0.92)
  .cpm(36)`
            }
        ];

        this.sampleBrowserPresets = [
            {
                id: 'vocal-knife',
                name: 'Vocal Knife Cuts',
                category: 'Vocal',
                description: 'Fast repeat chops that wake up a static groove without adding too much density.',
                laneDefaults: { laneId: 'vocal', steps: [4, 8, 12, 16], start: 0.06, end: 0.28, rate: 1.08, reverse: false }
            },
            {
                id: 'vocal-answer',
                name: 'Call / Response Vocal',
                category: 'Vocal',
                description: 'Space the phrase out so the vocal sounds like it is answering the drums instead of sitting on them.',
                laneDefaults: { laneId: 'vocal', steps: [8, 16], start: 0.18, end: 0.5, rate: 0.94, reverse: false }
            },
            {
                id: 'fx-stab-offbeat',
                name: 'Offbeat Stab Drive',
                category: 'FX',
                description: 'Classic rave stabs on the offbeats for extra pressure in the main section.',
                laneDefaults: { laneId: 'fx', steps: [4, 8, 12, 16], start: 0, end: 0.42, rate: 1, reverse: false }
            },
            {
                id: 'fx-riser-tail',
                name: 'Riser Tail',
                category: 'FX',
                description: 'Use the back end of a sample to create a lift into the next section.',
                laneDefaults: { laneId: 'fx', steps: [16], start: 0.56, end: 1, rate: 0.82, reverse: false }
            },
            {
                id: 'texture-reverse',
                name: 'Reverse Air',
                category: 'Texture',
                description: 'Soft reverse movement for transitions and build pressure without cluttering the beat.',
                laneDefaults: { laneId: 'texture', steps: [1, 9, 16], start: 0.08, end: 0.78, rate: 0.88, reverse: true }
            },
            {
                id: 'texture-ghost-bed',
                name: 'Ghost Bed',
                category: 'Texture',
                description: 'Low-key background movement that adds width and glue.',
                laneDefaults: { laneId: 'texture', steps: [1, 5, 9, 13], start: 0.2, end: 0.62, rate: 0.96, reverse: false }
            },
            {
                id: 'perc-skipper',
                name: 'Perc Skipper',
                category: 'Perc',
                description: 'A light broken shuffle that adds edge around the hats.',
                laneDefaults: { laneId: 'perc', steps: [3, 6, 11, 14], start: 0, end: 0.22, rate: 1.12, reverse: false }
            },
            {
                id: 'perc-rider',
                name: 'Ride Burst',
                category: 'Perc',
                description: 'Use a brighter sample on the later steps for a more urgent, open-end section.',
                laneDefaults: { laneId: 'perc', steps: [7, 8, 15, 16], start: 0, end: 0.18, rate: 1.18, reverse: false }
            }
        ];

        this.sampleState = {
            vocal: this.createEmptySampleLaneState(),
            fx: this.createEmptySampleLaneState(),
            texture: this.createEmptySampleLaneState(),
            perc: this.createEmptySampleLaneState()
        };

        this.projectMeta = this.createDefaultProjectMeta();
        this.projectPatterns = [];
        this.assistantSettings = this.createDefaultAssistantSettings();

        this.projectStorageKey = 'strudel-studio-project-v3-draft';
        this.legacyProjectStorageKey = 'strudel-studio-project-v2';
        this.projectDbName = 'strudel-studio-projects';
        this.projectStoreName = 'projects';
        this.assistantSettingsStorageKey = 'strudel-studio-local-ai-settings';
        this.projectPersistTimer = null;
        this.projectPersistDelayMs = 160;
        this.projectPersistDirty = false;
        this.exportPanelRefreshFrame = null;
        this.diagnosticsInterval = null;
        this.arrangementInteraction = null;
        this.draggedArrangementSectionId = null;
        this.maxAssistantMessages = 12;
        this.maxAssistantMessageLength = 4000;

        this.structureTemplates = {
            'radio-edit': [
                { sceneId: 'intro', name: 'Intro', bars: 8 },
                { sceneId: 'main', name: 'Main', bars: 24 },
                { sceneId: 'breakdown', name: 'Breakdown', bars: 8 },
                { sceneId: 'build', name: 'Build', bars: 8 },
                { sceneId: 'climax', name: 'Climax', bars: 16 },
                { sceneId: 'outro', name: 'Outro', bars: 8 }
            ],
            'dj-tool': [
                { sceneId: 'intro', name: 'Intro', bars: 16 },
                { sceneId: 'main', name: 'Main A', bars: 48 },
                { sceneId: 'breakdown', name: 'Breakdown', bars: 24 },
                { sceneId: 'build', name: 'Build', bars: 16 },
                { sceneId: 'climax', name: 'Climax', bars: 32 },
                { sceneId: 'outro', name: 'Outro', bars: 16 }
            ],
            'extended-mix': [
                { sceneId: 'intro', name: 'Intro', bars: 16 },
                { sceneId: 'main', name: 'Main A', bars: 32 },
                { sceneId: 'breakdown', name: 'Breakdown', bars: 16 },
                { sceneId: 'build', name: 'Build', bars: 16 },
                { sceneId: 'climax', name: 'Climax', bars: 24 },
                { sceneId: 'main', name: 'Main Return', bars: 24 },
                { sceneId: 'outro', name: 'Outro', bars: 12 }
            ]
        };

        this.dom = this.bindDom();
        this.defaultCode = this.buildDefaultCode();
        this.engine = new SimpleRaveEngine(this);
        this.init();
    }

    createEmptySampleLaneState() {
        return {
            buffer: null,
            reverseBuffer: null,
            blob: null,
            fileName: '',
            mimeType: '',
            start: 0,
            end: 1,
            rate: 1,
            reverse: false
        };
    }

    createDefaultProjectMeta() {
        return {
            id: `project-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
            name: 'Untitled Session',
            key: 'C#/Db major',
            notes: '',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };
    }

    createDefaultAssistantSettings() {
        return {
            endpoint: 'http://127.0.0.1:11434/v1',
            model: 'local-model',
            systemPrompt: 'You are a local Strudel composition partner. Help shape rhythmic, melodic, and arrangement ideas. Prefer short practical explanations and working Strudel code blocks when useful. Return the useful final answer directly in plain text.'
        };
    }

    createDefaultTrackStates() {
        return {
            mainbreak: { volume: 0.9, muted: false, solo: false, pan: -0.08 },
            kick: { volume: 0.8, muted: false, solo: false, pan: 0 },
            bass: { volume: 0.7, muted: false, solo: false, pan: -0.03 },
            stabs: { volume: 0.6, muted: false, solo: false, pan: 0.16 },
            lead: { volume: 0.5, muted: false, solo: false, pan: 0.24 },
            vocal: { volume: 0.8, muted: false, solo: false, pan: 0.06 },
            fx: { volume: 0.55, muted: false, solo: false, pan: 0.22 },
            percussion: { volume: 0.5, muted: false, solo: false, pan: -0.16 },
            texture: { volume: 0.42, muted: false, solo: false, pan: 0.3 },
            percshot: { volume: 0.38, muted: false, solo: false, pan: -0.22 }
        };
    }

    createDefaultGlobalEffects() {
        return {
            masterVolume: 0.8,
            tempo: 131,
            reverb: 0.3,
            delay: 0.25,
            filter: 0.5
        };
    }

    createDefaultSequenceConfig() {
        return {
            kickSteps: [1, 5, 9, 13],
            snareSteps: [5, 13],
            hatSteps: [1, 3, 5, 7, 9, 11, 13, 15],
            vocalSteps: [8, 16],
            fxSteps: [4, 12],
            textureSteps: [1, 9],
            percSteps: [3, 7, 11, 15]
        };
    }

    bindDom() {
        return {
            appContainer: document.getElementById('appContainer'),
            surfaceShells: document.getElementById('surfaceShells'),
            surfaceSectionPool: document.getElementById('surfaceSectionPool'),
            consoleSummaryStrip: document.getElementById('consoleSummaryStrip'),
            simpleShell: document.getElementById('simpleShell'),
            simpleLeftDock: document.getElementById('simpleLeftDock'),
            simpleCenterDock: document.getElementById('simpleCenterDock'),
            simpleRightDock: document.getElementById('simpleRightDock'),
            consoleDrawerViewport: document.getElementById('consoleDrawerViewport'),
            advancedShell: document.getElementById('advancedShell'),
            advancedTabViewport: document.getElementById('advancedTabViewport'),
            simpleViewBtn: document.getElementById('simpleViewBtn'),
            advancedViewBtn: document.getElementById('advancedViewBtn'),
            drawerTabButtons: Array.from(document.querySelectorAll('.console-drawer-tab')),
            advancedTabButtons: Array.from(document.querySelectorAll('.advanced-tab-btn')),
            structureTemplateButtons: Array.from(document.querySelectorAll('.structure-template-btn')),
            installAppBtn: document.getElementById('installAppBtn'),
            projectStatusText: document.getElementById('projectStatusText'),
            sessionTitleDisplay: document.getElementById('sessionTitleDisplay'),
            sessionTempoMeta: document.getElementById('sessionTempoMeta'),
            sessionKeyMeta: document.getElementById('sessionKeyMeta'),
            sessionPatternCountMeta: document.getElementById('sessionPatternCountMeta'),
            sessionClipCountMeta: document.getElementById('sessionClipCountMeta'),
            sessionNotesSummary: document.getElementById('sessionNotesSummary'),
            sessionSampleSummary: document.getElementById('sessionSampleSummary'),
            playStopBtn: document.getElementById('playStopBtn'),
            recordBtn: document.getElementById('recordBtn'),
            takeNameInput: document.getElementById('takeNameInput'),
            autoStopRecordInput: document.getElementById('autoStopRecordInput'),
            audioCheckBtn: document.getElementById('audioCheckBtn'),
            audioContextState: document.getElementById('audioContextState'),
            audioEngineState: document.getElementById('audioEngineState'),
            audioOutputState: document.getElementById('audioOutputState'),
            audioAlertText: document.getElementById('audioAlertText'),
            audioMeterValue: document.getElementById('audioMeterValue'),
            audioMeterFill: document.getElementById('audioMeterFill'),
            audioSoloState: document.getElementById('audioSoloState'),
            currentTime: document.getElementById('currentTime'),
            totalTime: document.getElementById('totalTime'),
            progressFill: document.getElementById('progressFill'),
            arrangementTimeline: document.getElementById('arrangementTimeline'),
            arrangementEditor: document.getElementById('arrangementEditor'),
            addSectionBtn: document.getElementById('addSectionBtn'),
            resetArrangementBtn: document.getElementById('resetArrangementBtn'),
            timelineMarker: document.getElementById('timelineMarker'),
            cycleNumber: document.getElementById('cycleNumber'),
            masterVolume: document.getElementById('masterVolume'),
            tempoSlider: document.getElementById('tempoSlider'),
            reverbSlider: document.getElementById('reverbSlider'),
            delaySlider: document.getElementById('delaySlider'),
            filterSlider: document.getElementById('filterSlider'),
            vocalSampleInput: document.getElementById('vocalSampleInput'),
            vocalStepInput: document.getElementById('vocalStepInput'),
            vocalStartSlider: document.getElementById('vocalStartSlider'),
            vocalEndSlider: document.getElementById('vocalEndSlider'),
            vocalRateSlider: document.getElementById('vocalRateSlider'),
            vocalReverseToggle: document.getElementById('vocalReverseToggle'),
            sampleStatus: document.getElementById('sampleStatus'),
            auditionVocalBtn: document.getElementById('auditionVocalBtn'),
            clearVocalBtn: document.getElementById('clearVocalBtn'),
            vocalStepGrid: document.getElementById('vocalStepGrid'),
            fxSampleInput: document.getElementById('fxSampleInput'),
            fxStepInput: document.getElementById('fxStepInput'),
            fxStartSlider: document.getElementById('fxStartSlider'),
            fxEndSlider: document.getElementById('fxEndSlider'),
            fxRateSlider: document.getElementById('fxRateSlider'),
            fxReverseToggle: document.getElementById('fxReverseToggle'),
            fxStatus: document.getElementById('fxStatus'),
            auditionFxBtn: document.getElementById('auditionFxBtn'),
            clearFxBtn: document.getElementById('clearFxBtn'),
            fxStepGrid: document.getElementById('fxStepGrid'),
            textureSampleInput: document.getElementById('textureSampleInput'),
            textureStepInput: document.getElementById('textureStepInput'),
            textureStartSlider: document.getElementById('textureStartSlider'),
            textureEndSlider: document.getElementById('textureEndSlider'),
            textureRateSlider: document.getElementById('textureRateSlider'),
            textureReverseToggle: document.getElementById('textureReverseToggle'),
            textureStatus: document.getElementById('textureStatus'),
            auditionTextureBtn: document.getElementById('auditionTextureBtn'),
            clearTextureBtn: document.getElementById('clearTextureBtn'),
            textureStepGrid: document.getElementById('textureStepGrid'),
            percSampleInput: document.getElementById('percSampleInput'),
            percStepInput: document.getElementById('percStepInput'),
            percStartSlider: document.getElementById('percStartSlider'),
            percEndSlider: document.getElementById('percEndSlider'),
            percRateSlider: document.getElementById('percRateSlider'),
            percReverseToggle: document.getElementById('percReverseToggle'),
            percStatus: document.getElementById('percStatus'),
            auditionPercBtn: document.getElementById('auditionPercBtn'),
            clearPercBtn: document.getElementById('clearPercBtn'),
            percStepGrid: document.getElementById('percStepGrid'),
            kickStepGrid: document.getElementById('kickStepGrid'),
            snareStepGrid: document.getElementById('snareStepGrid'),
            hatStepGrid: document.getElementById('hatStepGrid'),
            kickStepSummary: document.getElementById('kickStepSummary'),
            snareStepSummary: document.getElementById('snareStepSummary'),
            hatStepSummary: document.getElementById('hatStepSummary'),
            sequenceTargetLane: document.getElementById('sequenceTargetLane'),
            sampleBrowserSearch: document.getElementById('sampleBrowserSearch'),
            sampleBrowserTargetLane: document.getElementById('sampleBrowserTargetLane'),
            sampleBrowserList: document.getElementById('sampleBrowserList'),
            clipLibraryList: document.getElementById('clipLibraryList'),
            capturePatternBtn: document.getElementById('capturePatternBtn'),
            patternRackList: document.getElementById('patternRackList'),
            newProjectBtn: document.getElementById('newProjectBtn'),
            duplicateProjectBtn: document.getElementById('duplicateProjectBtn'),
            projectNameInput: document.getElementById('projectNameInput'),
            projectKeyInput: document.getElementById('projectKeyInput'),
            projectTempoInput: document.getElementById('projectTempoInput'),
            projectNotesInput: document.getElementById('projectNotesInput'),
            projectLibraryList: document.getElementById('projectLibraryList'),
            saveProjectBtn: document.getElementById('saveProjectBtn'),
            exportProjectBtn: document.getElementById('exportProjectBtn'),
            importProjectBtn: document.getElementById('importProjectBtn'),
            importProjectInput: document.getElementById('importProjectInput'),
            refreshExportJsonBtn: document.getElementById('refreshExportJsonBtn'),
            copyProjectJsonBtn: document.getElementById('copyProjectJsonBtn'),
            downloadProjectJsonBtn: document.getElementById('downloadProjectJsonBtn'),
            exportJsonTextarea: document.getElementById('exportJsonTextarea'),
            sceneDescription: document.getElementById('sceneDescription'),
            studioLayoutBtn: document.getElementById('studioLayoutBtn'),
            splitLayoutBtn: document.getElementById('splitLayoutBtn'),
            codeLayoutBtn: document.getElementById('codeLayoutBtn'),
            toggleCodeBtn: document.getElementById('toggleCodeBtn'),
            toggleAssistantBtn: document.getElementById('toggleAssistantBtn'),
            updateCodeBtn: document.getElementById('updateCodeBtn'),
            resetCodeBtn: document.getElementById('resetCodeBtn'),
            exportCodeBtn: document.getElementById('exportCodeBtn'),
            codeEditor: document.getElementById('codeEditor'),
            codeTextarea: document.getElementById('strudelCode'),
            strudelPanel: document.getElementById('strudelRepl'),
            assistantPanel: document.getElementById('assistantPanel'),
            assistantMessages: document.getElementById('assistantMessages'),
            assistantPromptInput: document.getElementById('assistantPromptInput'),
            assistantSendBtn: document.getElementById('assistantSendBtn'),
            assistantStatus: document.getElementById('assistantStatus'),
            detectAssistantBtn: document.getElementById('detectAssistantBtn'),
            testAssistantBtn: document.getElementById('testAssistantBtn'),
            clearAssistantChatBtn: document.getElementById('clearAssistantChatBtn'),
            assistantEndpointInput: document.getElementById('assistantEndpointInput'),
            assistantModelInput: document.getElementById('assistantModelInput'),
            assistantSystemPrompt: document.getElementById('assistantSystemPrompt'),
            assistantSuggestionButtons: Array.from(document.querySelectorAll('.assistant-suggestion')),
            sceneButtons: Array.from(document.querySelectorAll('.scene-btn')),
            rhythmPresetButtons: Array.from(document.querySelectorAll('.rhythm-preset-btn')),
            rhythmActionButtons: Array.from(document.querySelectorAll('.rhythm-action-btn')),
            sequencerActionButtons: Array.from(document.querySelectorAll('.sequencer-action-btn')),
            exampleLibraryList: document.getElementById('exampleLibraryList'),
            trackInfoSection: document.querySelector('.track-info'),
            mainControlsSection: document.querySelector('.main-controls'),
            audioDiagnosticsSection: document.querySelector('.audio-diagnostics'),
            trackStructureSection: document.querySelector('.track-structure'),
            sceneControlsSection: document.querySelector('.scene-controls'),
            patternRackSection: document.querySelector('.pattern-rack'),
            rhythmDesignerSection: document.querySelector('.rhythm-designer'),
            mixerSection: document.querySelector('.track-controls'),
            samplerSection: document.querySelector('.sampler-controls'),
            sampleBrowserSection: document.querySelector('.sample-browser'),
            effectsSection: document.querySelector('.effect-controls'),
            visualizerSection: document.querySelector('.visualizer'),
            factorySection: document.querySelector('.example-library'),
            workspaceSection: document.querySelector('.code-section'),
            projectsSection: document.querySelector('.project-controls'),
            exportSection: document.querySelector('.export-panel'),
            infoSection: document.querySelector('.info-panel')
        };
    }

    init() {
        this.buildRhythmStepButtons();
        this.buildVocalStepButtons();
        this.buildFxStepButtons();
        this.buildTextureStepButtons();
        this.buildPercStepButtons();
        this.enhanceMixerTracks();
        this.renderExampleLibrary();
        this.restoreAssistantSettings();
        this.loadSavedProject();
        if (!this.userHasCustomCode || !this.dom.codeTextarea.value) {
            this.dom.codeTextarea.value = this.defaultCode;
        }
        this.renderStrudelStatus('Local audio engine ready on Play. Strudel code remains editable and exportable from this panel.', 'info');
        this.setupEventListeners();
        this.syncDomFromState();
        this.renderSampleBrowser();
        this.renderAssistantMessages();
        this.renderWorkspaceState();
        this.updateTimeDisplay();
        this.updateVolumeDisplays();
        this.updateEffectDisplays();
        this.updateRecordingButton();
        this.updateSampleStatus();
        this.updateFxStatus();
        this.updateTextureStatus();
        this.updatePercStatus();
        this.setupCodeEditor();
        this.registerPwaSupport();
        this.hydrateStaticCopy();
        this.renderInterfaceShell();
        this.startDiagnosticsLoop();
        this.renderAudioDiagnostics();
        this.dom.appContainer.dataset.shellReady = 'true';
        document.body.classList.add('shell-ready');
        this.loadProjectLibrary().catch((error) => console.warn('Could not load project library:', error));
    }

    hydrateStaticCopy() {
        const exportHelper = this.dom.exportSection?.querySelector('.helper-text');
        if (exportHelper) {
            exportHelper.textContent = 'Copy or download the clean session JSON here. Use Export Project above when you want the full package with embedded lane audio.';
        }
    }

    getSurfaceSections() {
        return [
            this.dom.trackInfoSection,
            this.dom.mainControlsSection,
            this.dom.audioDiagnosticsSection,
            this.dom.trackStructureSection,
            this.dom.sceneControlsSection,
            this.dom.patternRackSection,
            this.dom.rhythmDesignerSection,
            this.dom.mixerSection,
            this.dom.samplerSection,
            this.dom.sampleBrowserSection,
            this.dom.effectsSection,
            this.dom.visualizerSection,
            this.dom.factorySection,
            this.dom.workspaceSection,
            this.dom.projectsSection,
            this.dom.exportSection,
            this.dom.infoSection
        ].filter(Boolean);
    }

    mountSections(target, sections = []) {
        if (!target) {
            return;
        }

        target.replaceChildren();
        sections.filter(Boolean).forEach((section) => target.appendChild(section));
    }

    renderInterfaceShell() {
        const allSections = this.getSurfaceSections();
        allSections.forEach((section) => this.dom.surfaceSectionPool.appendChild(section));

        this.mountSections(this.dom.consoleSummaryStrip, [
            this.dom.trackInfoSection,
            this.dom.mainControlsSection,
            this.dom.audioDiagnosticsSection
        ]);

        this.dom.appContainer.dataset.interfaceMode = this.interfaceMode;
        this.dom.appContainer.dataset.advancedTab = this.advancedTab;
        this.dom.appContainer.dataset.drawerTab = this.consoleDrawerTab;
        this.dom.simpleShell.hidden = this.interfaceMode !== 'simple';
        this.dom.advancedShell.hidden = this.interfaceMode !== 'advanced';

        this.dom.simpleViewBtn.classList.toggle('active', this.interfaceMode === 'simple');
        this.dom.simpleViewBtn.setAttribute('aria-pressed', String(this.interfaceMode === 'simple'));
        this.dom.advancedViewBtn.classList.toggle('active', this.interfaceMode === 'advanced');
        this.dom.advancedViewBtn.setAttribute('aria-pressed', String(this.interfaceMode === 'advanced'));

        this.dom.drawerTabButtons.forEach((button) => {
            const isActive = button.dataset.drawerTab === this.consoleDrawerTab;
            button.classList.toggle('active', isActive);
            button.setAttribute('aria-pressed', String(isActive));
        });

        this.dom.advancedTabButtons.forEach((button) => {
            const isActive = button.dataset.advancedTab === this.advancedTab;
            button.classList.toggle('active', isActive);
            button.setAttribute('aria-pressed', String(isActive));
        });

        if (this.interfaceMode === 'simple') {
            this.mountSections(this.dom.simpleLeftDock, [
                this.dom.trackStructureSection,
                this.dom.sceneControlsSection,
                this.dom.patternRackSection
            ]);
            this.mountSections(this.dom.simpleCenterDock, [
                this.dom.rhythmDesignerSection,
                this.dom.mixerSection,
                this.dom.effectsSection,
                this.dom.visualizerSection
            ]);
            this.mountSections(this.dom.simpleRightDock, [
                this.dom.samplerSection,
                this.dom.sampleBrowserSection
            ]);

            const drawerSections = {
                workspace: [this.dom.workspaceSection],
                projects: [this.dom.projectsSection, this.dom.exportSection],
                factory: [this.dom.factorySection],
                system: [this.dom.infoSection]
            };
            this.mountSections(this.dom.consoleDrawerViewport, drawerSections[this.consoleDrawerTab] || drawerSections.projects);
            this.mountSections(this.dom.advancedTabViewport, []);
            return;
        }

        const advancedSections = {
            arrange: [this.dom.trackStructureSection, this.dom.sceneControlsSection, this.dom.patternRackSection],
            sound: [this.dom.rhythmDesignerSection, this.dom.mixerSection, this.dom.effectsSection, this.dom.visualizerSection, this.dom.factorySection],
            samples: [this.dom.samplerSection, this.dom.sampleBrowserSection],
            code: [this.dom.workspaceSection],
            projects: [this.dom.projectsSection, this.dom.exportSection, this.dom.infoSection]
        };
        this.mountSections(this.dom.simpleLeftDock, []);
        this.mountSections(this.dom.simpleCenterDock, []);
        this.mountSections(this.dom.simpleRightDock, []);
        this.mountSections(this.dom.consoleDrawerViewport, []);
        this.mountSections(this.dom.advancedTabViewport, advancedSections[this.advancedTab] || advancedSections.arrange);
    }

    setInterfaceMode(mode) {
        const nextMode = mode === 'advanced' ? 'advanced' : 'simple';
        if (nextMode === this.interfaceMode) {
            return;
        }

        this.interfaceMode = nextMode;
        if (this.interfaceMode === 'advanced' && this.advancedTab === 'code' && this.workspaceLayout === 'studio') {
            this.workspaceLayout = 'split';
            this.assistantVisible = false;
            this.renderWorkspaceState();
        }

        this.renderInterfaceShell();
        this.persistProject();
    }

    setConsoleDrawerTab(tab) {
        const nextTab = ['workspace', 'projects', 'factory', 'system'].includes(tab) ? tab : 'projects';
        this.consoleDrawerTab = nextTab;
        if (nextTab === 'workspace' && this.workspaceLayout === 'studio') {
            this.workspaceLayout = 'split';
            this.renderWorkspaceState();
        }

        this.renderInterfaceShell();
        this.persistProject();
    }

    setAdvancedTab(tab) {
        const nextTab = ['arrange', 'sound', 'samples', 'code', 'projects'].includes(tab) ? tab : 'arrange';
        this.advancedTab = nextTab;
        if (nextTab === 'code' && this.workspaceLayout === 'studio') {
            this.workspaceLayout = 'split';
            this.renderWorkspaceState();
        }

        this.renderInterfaceShell();
        this.persistProject();
    }

    revealWorkspaceSurface() {
        if (this.interfaceMode === 'simple') {
            this.consoleDrawerTab = 'workspace';
            return;
        }

        this.advancedTab = 'code';
    }

    createDefaultArrangement() {
        return [
            this.createArrangementSection('intro', 'Intro', 8),
            this.createArrangementSection('main', 'Main', 40),
            this.createArrangementSection('breakdown', 'Breakdown', 16),
            this.createArrangementSection('build', 'Build', 16),
            this.createArrangementSection('climax', 'Climax', 24),
            this.createArrangementSection('outro', 'Outro', 12)
        ];
    }

    createArrangementSection(sceneId = 'main', name = '', bars = 8) {
        const fallbackLabel = this.scenePresets[sceneId]?.label || 'Section';
        const safeBars = Number.isFinite(Number(bars)) && Number(bars) > 0 ? Math.round(Number(bars)) : 8;
        return {
            id: `section-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
            sceneId,
            name: name || fallbackLabel,
            bars: safeBars
        };
    }

    normalizeArrangement(arrangement) {
        if (!Array.isArray(arrangement) || !arrangement.length) {
            return this.createDefaultArrangement();
        }

        return arrangement
            .map((section) => {
                if (!section || typeof section !== 'object') {
                    return null;
                }

                const sceneId = this.scenePresets[section.sceneId] ? section.sceneId : 'main';
                const bars = Number.parseInt(section.bars, 10);

                return {
                    id: typeof section.id === 'string' && section.id ? section.id : `section-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
                    sceneId,
                    name: typeof section.name === 'string' && section.name.trim()
                        ? section.name.trim()
                        : (this.scenePresets[sceneId]?.label || 'Section'),
                    bars: Number.isFinite(bars) && bars > 0 ? bars : 8
                };
            })
            .filter(Boolean);
    }

    getArrangementBars() {
        return this.arrangement.reduce((sum, section) => sum + Math.max(1, Number(section.bars) || 0), 0) || 1;
    }

    getBarDuration() {
        return 240 / this.globalEffects.tempo;
    }

    refreshTimelineMetrics() {
        this.totalTime = this.getArrangementBars() * this.getBarDuration();

        if (this.currentTime >= this.totalTime) {
            this.currentTime = 0;
        }

        this.updateTimeDisplay();
        this.updateProgress();
        this.updateTimelineMarker();
    }

    startDiagnosticsLoop() {
        if (this.diagnosticsInterval) {
            clearInterval(this.diagnosticsInterval);
        }

        this.diagnosticsInterval = window.setInterval(() => {
            this.renderAudioDiagnostics();
        }, 140);
    }

    renderAudioDiagnostics() {
        if (!this.dom.audioContextState) {
            return;
        }

        const contextState = this.engine.audioContext?.state || 'idle';
        const meterLevel = this.engine.getMeterLevel();
        const meterPercent = Math.round(meterLevel * 100);
        const anySolo = Object.values(this.trackStates).some((track) => track.solo);
        const soloTracks = Object.entries(this.trackStates)
            .filter(([, trackState]) => trackState.solo)
            .map(([trackId]) => this.getLaneLabel(trackId))
            .filter(Boolean);
        const allMuted = Object.values(this.trackStates).every((track) => track.muted);
        const masterMuted = this.globalEffects.masterVolume <= 0.01;
        const engineRunning = this.engine.isRunning || this.isPlaying;
        const outputLive = meterPercent > 4 || this.engine.activeNodes.size > 0;

        this.dom.audioContextState.textContent = contextState === 'idle' ? 'Idle' : contextState.replace(/^./, (character) => character.toUpperCase());
        this.dom.audioEngineState.textContent = engineRunning ? `Running · beat ${this.currentBeat}` : 'Stopped';
        this.dom.audioOutputState.textContent = outputLive ? 'Signal present' : (engineRunning ? 'Low signal' : 'Signal idle');
        this.dom.audioMeterValue.textContent = `${meterPercent}%`;
        this.dom.audioMeterFill.style.width = `${Math.max(2, meterPercent)}%`;
        this.dom.audioMeterFill.style.opacity = outputLive ? '1' : '0.45';

        let alertText = 'Signal path looks clear.';
        if (contextState === 'idle' || contextState === 'suspended') {
            alertText = 'Press Play or Audio Check to unlock browser audio.';
        } else if (masterMuted) {
            alertText = 'Master volume is effectively muted.';
        } else if (allMuted) {
            alertText = 'All mixer channels are muted.';
        } else if (anySolo) {
            alertText = 'Solo monitoring is active, so some channels are intentionally hidden.';
        } else if (engineRunning && !outputLive) {
            alertText = 'Transport is running, but the current groove is not producing much visible signal yet.';
        }

        this.dom.audioAlertText.textContent = alertText;
        this.dom.audioSoloState.textContent = anySolo
            ? `Solo active on ${soloTracks.join(', ')}.`
            : (masterMuted ? 'Raise the master slider to hear the mix.' : 'No channel warnings.');
    }

    async runAudioCheck() {
        await this.engine.playAudioCheckTone();
        this.renderAudioDiagnostics();
        this.renderStrudelStatus('Played the direct audio check tone. If you still hear nothing, inspect browser permissions, output device routing, or system volume.', 'ready');
        this.showNotification('Audio check tone played.', 'success');
    }

    formatTime(seconds) {
        const minutes = Math.floor(seconds / 60);
        const remainder = Math.floor(seconds % 60);
        return `${minutes}:${String(remainder).padStart(2, '0')}`;
    }

    buildRhythmStepButtons() {
        const rhythmTargets = [
            ['kick', this.dom.kickStepGrid, 'step-toggle--kick'],
            ['snare', this.dom.snareStepGrid, 'step-toggle--snare'],
            ['hat', this.dom.hatStepGrid, 'step-toggle--hat']
        ];

        rhythmTargets.forEach(([laneId, container, modifierClass]) => {
            if (!container || container.children.length > 0) {
                return;
            }

            for (let step = 1; step <= 16; step += 1) {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = `step-toggle ${modifierClass}`;
                button.dataset.step = String(step);
                button.textContent = String(step);
                button.setAttribute('aria-pressed', 'false');
                button.addEventListener('click', () => this.toggleRhythmStep(laneId, step));
                container.appendChild(button);
            }
        });
    }

    buildVocalStepButtons() {
        if (!this.dom.vocalStepGrid || this.dom.vocalStepGrid.children.length > 0) {
            return;
        }

        for (let step = 1; step <= 16; step += 1) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'step-toggle';
            button.dataset.step = String(step);
            button.textContent = String(step);
            button.setAttribute('aria-pressed', 'false');
            button.addEventListener('click', () => this.toggleVocalStep(step));
            this.dom.vocalStepGrid.appendChild(button);
        }
    }

    buildFxStepButtons() {
        if (!this.dom.fxStepGrid || this.dom.fxStepGrid.children.length > 0) {
            return;
        }

        for (let step = 1; step <= 16; step += 1) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'step-toggle step-toggle--accent';
            button.dataset.step = String(step);
            button.textContent = String(step);
            button.setAttribute('aria-pressed', 'false');
            button.addEventListener('click', () => this.toggleFxStep(step));
            this.dom.fxStepGrid.appendChild(button);
        }
    }

    buildTextureStepButtons() {
        if (!this.dom.textureStepGrid || this.dom.textureStepGrid.children.length > 0) {
            return;
        }

        for (let step = 1; step <= 16; step += 1) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'step-toggle step-toggle--texture';
            button.dataset.step = String(step);
            button.textContent = String(step);
            button.setAttribute('aria-pressed', 'false');
            button.addEventListener('click', () => this.toggleTextureStep(step));
            this.dom.textureStepGrid.appendChild(button);
        }
    }

    buildPercStepButtons() {
        if (!this.dom.percStepGrid || this.dom.percStepGrid.children.length > 0) {
            return;
        }

        for (let step = 1; step <= 16; step += 1) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'step-toggle step-toggle--perc';
            button.dataset.step = String(step);
            button.textContent = String(step);
            button.setAttribute('aria-pressed', 'false');
            button.addEventListener('click', () => this.togglePercStep(step));
            this.dom.percStepGrid.appendChild(button);
        }
    }

    enhanceMixerTracks() {
        document.querySelectorAll('.track-control').forEach((trackControl) => {
            if (trackControl.querySelector('.solo-btn')) {
                return;
            }

            const header = trackControl.querySelector('.track-header');
            const trackId = trackControl.dataset.track;
            const volumeBlock = trackControl.querySelector('.track-volume');

            if (!header || !volumeBlock || !trackId) {
                return;
            }

            const soloButton = document.createElement('button');
            soloButton.type = 'button';
            soloButton.className = 'btn btn--sm btn--outline solo-btn';
            soloButton.textContent = 'Solo';
            header.appendChild(soloButton);

            const panBlock = document.createElement('div');
            panBlock.className = 'track-pan';
            panBlock.innerHTML = `
                <label>Pan</label>
                <input type="range" class="track-pan-slider" min="-100" max="100" value="0" data-track="${trackId}">
                <span class="pan-display">C</span>
            `;
            volumeBlock.insertAdjacentElement('afterend', panBlock);
        });
    }

    syncDomFromState() {
        this.dom.masterVolume.value = Math.round(this.globalEffects.masterVolume * 100);
        this.dom.tempoSlider.value = this.globalEffects.tempo;
        this.dom.reverbSlider.value = Math.round(this.globalEffects.reverb * 100);
        this.dom.delaySlider.value = Math.round(this.globalEffects.delay * 100);
        this.dom.filterSlider.value = Math.round(this.globalEffects.filter * 100);
        this.dom.takeNameInput.value = this.recordingOptions.takeLabel;
        this.dom.autoStopRecordInput.checked = this.recordingOptions.autoStopAtEnd;
        this.dom.projectNameInput.value = this.projectMeta.name;
        this.dom.projectKeyInput.value = this.projectMeta.key || '';
        this.dom.projectTempoInput.value = this.globalEffects.tempo;
        this.dom.projectNotesInput.value = this.projectMeta.notes;
        this.updateRhythmSummaries();
        this.dom.vocalStepInput.value = this.sequenceConfig.vocalSteps.join(',');
        this.dom.vocalStartSlider.value = Math.round(this.sampleState.vocal.start * 100);
        this.dom.vocalEndSlider.value = Math.round(this.sampleState.vocal.end * 100);
        this.dom.vocalRateSlider.value = Math.round(this.sampleState.vocal.rate * 100);
        this.dom.vocalReverseToggle.checked = this.sampleState.vocal.reverse;
        this.dom.fxStepInput.value = this.sequenceConfig.fxSteps.join(',');
        this.dom.fxStartSlider.value = Math.round(this.sampleState.fx.start * 100);
        this.dom.fxEndSlider.value = Math.round(this.sampleState.fx.end * 100);
        this.dom.fxRateSlider.value = Math.round(this.sampleState.fx.rate * 100);
        this.dom.fxReverseToggle.checked = this.sampleState.fx.reverse;
        this.dom.textureStepInput.value = this.sequenceConfig.textureSteps.join(',');
        this.dom.textureStartSlider.value = Math.round(this.sampleState.texture.start * 100);
        this.dom.textureEndSlider.value = Math.round(this.sampleState.texture.end * 100);
        this.dom.textureRateSlider.value = Math.round(this.sampleState.texture.rate * 100);
        this.dom.textureReverseToggle.checked = this.sampleState.texture.reverse;
        this.dom.percStepInput.value = this.sequenceConfig.percSteps.join(',');
        this.dom.percStartSlider.value = Math.round(this.sampleState.perc.start * 100);
        this.dom.percEndSlider.value = Math.round(this.sampleState.perc.end * 100);
        this.dom.percRateSlider.value = Math.round(this.sampleState.perc.rate * 100);
        this.dom.percReverseToggle.checked = this.sampleState.perc.reverse;

        document.querySelectorAll('.track-volume-slider').forEach((slider) => {
            const trackId = slider.dataset.track;
            const trackState = this.trackStates[trackId];
            if (trackState) {
                slider.value = Math.round(trackState.volume * 100);
                const trackControl = slider.closest('.track-control');
                const muteButton = trackControl?.querySelector('.mute-btn');
                const soloButton = trackControl?.querySelector('.solo-btn');
                const panSlider = trackControl?.querySelector('.track-pan-slider');
                const panValue = trackControl?.querySelector('.pan-display');
                if (muteButton) {
                    muteButton.classList.toggle('active', trackState.muted);
                    muteButton.textContent = trackState.muted ? 'Unmute' : 'Mute';
                }
                if (soloButton) {
                    soloButton.classList.toggle('active', trackState.solo);
                    soloButton.textContent = trackState.solo ? 'Soloed' : 'Solo';
                }
                if (panSlider) {
                    panSlider.value = Math.round(trackState.pan * 100);
                }
                if (panValue) {
                    this.updatePanDisplay(panValue, Math.round(trackState.pan * 100));
                }
                trackControl?.classList.toggle('muted', trackState.muted);
                trackControl?.classList.toggle('soloed', trackState.solo);
            }
        });

        this.renderRhythmStepGrid();
        this.renderVocalStepGrid();
        this.renderFxStepGrid();
        this.renderTextureStepGrid();
        this.renderPercStepGrid();
        this.renderSceneState();
        this.renderArrangementTimeline();
        this.renderArrangementEditor();
        this.renderPatternRack();
        this.renderClipLibrary();
        this.renderProjectMeta();
        this.renderExportPanel();
        this.refreshTimelineMetrics();
    }

    renderRhythmStepGrid() {
        const rhythmTargets = [
            ['kick', this.dom.kickStepGrid],
            ['snare', this.dom.snareStepGrid],
            ['hat', this.dom.hatStepGrid]
        ];

        rhythmTargets.forEach(([laneId, container]) => {
            if (!container) {
                return;
            }

            const activeSteps = new Set(this.sequenceConfig[`${laneId}Steps`] || []);
            container.querySelectorAll('.step-toggle').forEach((button) => {
                const step = parseInt(button.dataset.step, 10);
                const isActive = activeSteps.has(step);
                button.classList.toggle('active', isActive);
                button.setAttribute('aria-pressed', String(isActive));
            });
        });
    }

    renderVocalStepGrid() {
        if (!this.dom.vocalStepGrid) {
            return;
        }

        const activeSteps = new Set(this.sequenceConfig.vocalSteps);
        this.dom.vocalStepGrid.querySelectorAll('.step-toggle').forEach((button) => {
            const step = parseInt(button.dataset.step, 10);
            const isActive = activeSteps.has(step);
            button.classList.toggle('active', isActive);
            button.setAttribute('aria-pressed', String(isActive));
        });
    }

    renderFxStepGrid() {
        if (!this.dom.fxStepGrid) {
            return;
        }

        const activeSteps = new Set(this.sequenceConfig.fxSteps);
        this.dom.fxStepGrid.querySelectorAll('.step-toggle').forEach((button) => {
            const step = parseInt(button.dataset.step, 10);
            const isActive = activeSteps.has(step);
            button.classList.toggle('active', isActive);
            button.setAttribute('aria-pressed', String(isActive));
        });
    }

    renderTextureStepGrid() {
        if (!this.dom.textureStepGrid) {
            return;
        }

        const activeSteps = new Set(this.sequenceConfig.textureSteps);
        this.dom.textureStepGrid.querySelectorAll('.step-toggle').forEach((button) => {
            const step = parseInt(button.dataset.step, 10);
            const isActive = activeSteps.has(step);
            button.classList.toggle('active', isActive);
            button.setAttribute('aria-pressed', String(isActive));
        });
    }

    renderPercStepGrid() {
        if (!this.dom.percStepGrid) {
            return;
        }

        const activeSteps = new Set(this.sequenceConfig.percSteps);
        this.dom.percStepGrid.querySelectorAll('.step-toggle').forEach((button) => {
            const step = parseInt(button.dataset.step, 10);
            const isActive = activeSteps.has(step);
            button.classList.toggle('active', isActive);
            button.setAttribute('aria-pressed', String(isActive));
        });
    }

    renderSceneState() {
        const scene = this.scenePresets[this.activeScene];
        const description = scene
            ? `${scene.label}: ${scene.description}`
            : 'Custom: your mix no longer matches one preset, so keep shaping it freely.';

        if (this.dom.sceneDescription) {
            this.dom.sceneDescription.textContent = description;
        }

        this.dom.sceneButtons.forEach((button) => {
            const isActive = button.dataset.scene === this.activeScene;
            button.classList.toggle('active', isActive);
            button.setAttribute('aria-pressed', String(isActive));
        });

        this.renderArrangementTimeline();
    }

    markSceneCustom() {
        if (this.activeScene !== 'custom') {
            this.activeScene = 'custom';
            this.renderSceneState();
        }
    }

    parseVocalSteps(value) {
        return Array.from(
            new Set(
                value
                    .split(',')
                    .map((part) => parseInt(part.trim(), 10))
                    .filter((step) => Number.isInteger(step) && step >= 1 && step <= 16)
            )
        ).sort((left, right) => left - right);
    }

    formatStepSummary(steps) {
        if (!steps.length) {
            return 'none';
        }

        if (steps.length === 16 && steps[0] === 1 && steps[15] === 16) {
            return '1-16';
        }

        return steps.join(', ');
    }

    buildSamplePattern(steps, token) {
        const hitSet = new Set(steps);
        return Array.from({ length: 16 }, (_, index) => (hitSet.has(index + 1) ? token : '~')).join(' ');
    }

    updateRhythmSummaries() {
        if (this.dom.kickStepSummary) {
            this.dom.kickStepSummary.textContent = this.formatStepSummary(this.sequenceConfig.kickSteps);
        }

        if (this.dom.snareStepSummary) {
            this.dom.snareStepSummary.textContent = this.formatStepSummary(this.sequenceConfig.snareSteps);
        }

        if (this.dom.hatStepSummary) {
            this.dom.hatStepSummary.textContent = this.formatStepSummary(this.sequenceConfig.hatSteps);
        }
    }

    updateSampleStatus() {
        const vocal = this.sampleState.vocal;
        const stepSummary = this.sequenceConfig.vocalSteps.join(', ') || 'none';

        if (vocal.buffer || vocal.blob) {
            const start = Math.round(vocal.start * 100);
            const end = Math.round(vocal.end * 100);
            const rate = Math.round(vocal.rate * 100);
            const reverseText = vocal.reverse ? ' reversed' : '';
            this.dom.sampleStatus.textContent = `${vocal.fileName} loaded. Triggering on steps ${stepSummary}. Slice ${start}% to ${end}% at ${rate}% speed${reverseText}.`;
            this.renderClipLibrary();
            return;
        }

        this.dom.sampleStatus.textContent = `Using the built-in factory vocal layer on steps ${stepSummary}. Import a sample whenever you want custom vocal chops.`;
        this.renderClipLibrary();
    }

    updateFxStatus() {
        const fx = this.sampleState.fx;
        const stepSummary = this.sequenceConfig.fxSteps.join(', ') || 'none';

        if (fx.buffer || fx.blob) {
            const start = Math.round(fx.start * 100);
            const end = Math.round(fx.end * 100);
            const rate = Math.round(fx.rate * 100);
            const reverseText = fx.reverse ? ' reversed' : '';
            this.dom.fxStatus.textContent = `${fx.fileName} loaded. Triggering on steps ${stepSummary}. Slice ${start}% to ${end}% at ${rate}% speed${reverseText}.`;
            this.renderClipLibrary();
            return;
        }

        this.dom.fxStatus.textContent = `Using the built-in factory stab layer on steps ${stepSummary}. Import a sample to turn this lane into your own FX or stab lane.`;
        this.renderClipLibrary();
    }

    updateTextureStatus() {
        const texture = this.sampleState.texture;
        const stepSummary = this.sequenceConfig.textureSteps.join(', ') || 'none';

        if (texture.buffer || texture.blob) {
            const start = Math.round(texture.start * 100);
            const end = Math.round(texture.end * 100);
            const rate = Math.round(texture.rate * 100);
            const reverseText = texture.reverse ? ' reversed' : '';
            this.dom.textureStatus.textContent = `${texture.fileName} loaded. Triggering on steps ${stepSummary}. Slice ${start}% to ${end}% at ${rate}% speed${reverseText}.`;
            this.renderClipLibrary();
            return;
        }

        this.dom.textureStatus.textContent = `Using the built-in factory texture pulse on steps ${stepSummary}. Import your own riser, pad, or atmosphere sample for more movement.`;
        this.renderClipLibrary();
    }

    updatePercStatus() {
        const perc = this.sampleState.perc;
        const stepSummary = this.sequenceConfig.percSteps.join(', ') || 'none';

        if (perc.buffer || perc.blob) {
            const start = Math.round(perc.start * 100);
            const end = Math.round(perc.end * 100);
            const rate = Math.round(perc.rate * 100);
            const reverseText = perc.reverse ? ' reversed' : '';
            this.dom.percStatus.textContent = `${perc.fileName} loaded. Triggering on steps ${stepSummary}. Slice ${start}% to ${end}% at ${rate}% speed${reverseText}.`;
            this.renderClipLibrary();
            return;
        }

        this.dom.percStatus.textContent = `Using the built-in factory percussive click on steps ${stepSummary}. Import a shaker, clap, ride, or click to make this lane your own.`;
        this.renderClipLibrary();
    }

    getLaneLabel(laneId) {
        const labels = {
            mainbreak: 'Main Break',
            kick: 'Kick',
            bass: 'Bass',
            stabs: 'Stabs',
            lead: 'Lead',
            snare: 'Snare',
            hat: 'Hat',
            percussion: 'Percussion',
            vocal: 'Vocal',
            fx: 'FX',
            texture: 'Texture',
            perc: 'Perc',
            percshot: 'Perc Shot'
        };
        return labels[laneId] || 'Sample';
    }

    updateLaneStatus(laneId) {
        if (laneId === 'vocal') {
            this.updateSampleStatus();
        } else if (laneId === 'fx') {
            this.updateFxStatus();
        } else if (laneId === 'texture') {
            this.updateTextureStatus();
        } else if (laneId === 'perc') {
            this.updatePercStatus();
        }
    }

    createDefaultSampleLaneSettings() {
        return {
            fileName: '',
            mimeType: '',
            start: 0,
            end: 1,
            rate: 1,
            reverse: false
        };
    }

    cloneTrackStates(trackStates = this.trackStates) {
        return Object.fromEntries(
            Object.entries(trackStates).map(([trackId, trackState]) => ([
                trackId,
                { ...trackState }
            ]))
        );
    }

    cloneSequenceConfig(sequenceConfig = this.sequenceConfig) {
        return {
            kickSteps: [...sequenceConfig.kickSteps],
            snareSteps: [...sequenceConfig.snareSteps],
            hatSteps: [...sequenceConfig.hatSteps],
            vocalSteps: [...sequenceConfig.vocalSteps],
            fxSteps: [...sequenceConfig.fxSteps],
            textureSteps: [...sequenceConfig.textureSteps],
            percSteps: [...sequenceConfig.percSteps]
        };
    }

    cloneSampleSettings(sampleSettings = null) {
        return Object.fromEntries(
            ['vocal', 'fx', 'texture', 'perc'].map((laneId) => ([
                laneId,
                {
                    ...this.createDefaultSampleLaneSettings(),
                    ...(sampleSettings?.[laneId] || this.serializeSampleLaneSettings(laneId))
                }
            ]))
        );
    }

    normalizeSequenceConfig(sequenceConfig = {}) {
        const defaults = this.createDefaultSequenceConfig();
        return Object.fromEntries(
            Object.keys(defaults).map((key) => ([
                key,
                Array.isArray(sequenceConfig[key])
                    ? this.parseVocalSteps(sequenceConfig[key].join(','))
                    : [...defaults[key]]
            ]))
        );
    }

    normalizeProjectPatterns(patterns = []) {
        if (!Array.isArray(patterns)) {
            return [];
        }

        return patterns
            .map((pattern, index) => {
                const sceneId = this.scenePresets[pattern?.sceneId] ? pattern.sceneId : 'main';
                const createdAt = pattern?.createdAt || new Date().toISOString();
                const updatedAt = pattern?.updatedAt || createdAt;
                const fallbackName = `${this.scenePresets[sceneId]?.label || 'Pattern'} ${index + 1}`;

                return {
                    id: typeof pattern?.id === 'string' && pattern.id ? pattern.id : `pattern-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
                    name: typeof pattern?.name === 'string' && pattern.name.trim() ? pattern.name.trim() : fallbackName,
                    sceneId,
                    key: typeof pattern?.key === 'string' && pattern.key.trim() ? pattern.key.trim() : this.projectMeta.key,
                    createdAt,
                    updatedAt,
                    globalEffects: {
                        ...this.createDefaultGlobalEffects(),
                        ...(pattern?.globalEffects || {})
                    },
                    trackStates: this.normalizeTrackStates(pattern?.trackStates || {}),
                    sequenceConfig: this.normalizeSequenceConfig(pattern?.sequenceConfig || {}),
                    sampleSettings: this.cloneSampleSettings(pattern?.sampleSettings || {}),
                    customCode: typeof pattern?.customCode === 'string' ? pattern.customCode : this.defaultCode,
                    userHasCustomCode: Boolean(pattern?.userHasCustomCode)
                };
            })
            .slice(-24);
    }

    createPatternSnapshot(name = '') {
        const now = new Date().toISOString();
        const sceneId = this.scenePresets[this.activeScene] ? this.activeScene : 'main';
        const fallbackName = `${this.scenePresets[sceneId]?.label || 'Pattern'} ${this.projectPatterns.length + 1}`;

        return {
            id: `pattern-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
            name: name || fallbackName,
            sceneId,
            key: this.projectMeta.key,
            createdAt: now,
            updatedAt: now,
            globalEffects: {
                ...this.globalEffects
            },
            trackStates: this.cloneTrackStates(),
            sequenceConfig: this.cloneSequenceConfig(),
            sampleSettings: this.cloneSampleSettings(),
            customCode: this.dom.codeTextarea.value,
            userHasCustomCode: this.userHasCustomCode
        };
    }

    getLoadedClipEntries() {
        return ['vocal', 'fx', 'texture', 'perc'].map((laneId) => {
            const lane = this.sampleState[laneId];
            return {
                laneId,
                label: this.getLaneLabel(laneId),
                loaded: Boolean(lane?.blob || lane?.buffer || lane?.fileName),
                fileName: lane?.fileName || '',
                steps: (this.sequenceConfig[`${laneId}Steps`] || []).join(', ') || 'none',
                start: Math.round((lane?.start ?? 0) * 100),
                end: Math.round((lane?.end ?? 1) * 100),
                rate: Math.round((lane?.rate ?? 1) * 100),
                reverse: Boolean(lane?.reverse)
            };
        });
    }

    buildSessionSampleSummary() {
        const loadedEntries = this.getLoadedClipEntries().filter((entry) => entry.loaded);
        if (!loadedEntries.length) {
            return 'No imported clips yet. Use the lane importers or the template browser to seed this session.';
        }

        return loadedEntries
            .map((entry) => `${entry.label}: ${entry.fileName || 'loaded clip'} on ${entry.steps}`)
            .join(' | ');
    }

    renderSessionOverview() {
        if (!this.dom.sessionTitleDisplay) {
            return;
        }

        this.dom.sessionTitleDisplay.textContent = this.projectMeta.name || 'Untitled Session';
        this.dom.sessionTempoMeta.textContent = String(this.globalEffects.tempo);
        this.dom.sessionKeyMeta.textContent = this.projectMeta.key || 'Set a key';
        this.dom.sessionPatternCountMeta.textContent = String(this.projectPatterns.length);
        this.dom.sessionClipCountMeta.textContent = String(this.getLoadedClipEntries().filter((entry) => entry.loaded).length);
        this.dom.sessionNotesSummary.textContent = this.projectMeta.notes
            ? this.projectMeta.notes
            : `Arrangement holds ${this.arrangement.length} sections. Capture pattern snapshots as the session develops.`;
        this.dom.sessionSampleSummary.textContent = this.buildSessionSampleSummary();
    }

    renderProjectMeta() {
        if (!this.dom.projectStatusText) {
            return;
        }

        const updatedAt = this.projectMeta.updatedAt
            ? new Date(this.projectMeta.updatedAt).toLocaleString()
            : 'just now';
        this.dom.projectStatusText.textContent = `${this.projectMeta.name} | ${this.projectMeta.key} | saved ${updatedAt}`;
        this.renderSessionOverview();
    }

    openProjectDatabase() {
        if (!this.projectDbPromise) {
            this.projectDbPromise = new Promise((resolve, reject) => {
                const request = window.indexedDB.open(this.projectDbName, 1);

                request.addEventListener('upgradeneeded', () => {
                    const db = request.result;
                    if (!db.objectStoreNames.contains(this.projectStoreName)) {
                        db.createObjectStore(this.projectStoreName, { keyPath: 'id' });
                    }
                });

                request.addEventListener('success', () => resolve(request.result));
                request.addEventListener('error', () => reject(request.error));
            });
        }

        return this.projectDbPromise;
    }

    async saveProjectRecord(record) {
        const db = await this.openProjectDatabase();
        await new Promise((resolve, reject) => {
            const transaction = db.transaction(this.projectStoreName, 'readwrite');
            transaction.objectStore(this.projectStoreName).put(record);
            transaction.addEventListener('complete', resolve);
            transaction.addEventListener('error', () => reject(transaction.error));
            transaction.addEventListener('abort', () => reject(transaction.error));
        });
    }

    async getProjectRecord(id) {
        const db = await this.openProjectDatabase();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(this.projectStoreName, 'readonly');
            const request = transaction.objectStore(this.projectStoreName).get(id);
            request.addEventListener('success', () => resolve(request.result || null));
            request.addEventListener('error', () => reject(request.error));
        });
    }

    async getAllProjectRecords() {
        const db = await this.openProjectDatabase();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(this.projectStoreName, 'readonly');
            const request = transaction.objectStore(this.projectStoreName).getAll();
            request.addEventListener('success', () => resolve(request.result || []));
            request.addEventListener('error', () => reject(request.error));
        });
    }

    async deleteProjectRecord(id) {
        const db = await this.openProjectDatabase();
        await new Promise((resolve, reject) => {
            const transaction = db.transaction(this.projectStoreName, 'readwrite');
            transaction.objectStore(this.projectStoreName).delete(id);
            transaction.addEventListener('complete', resolve);
            transaction.addEventListener('error', () => reject(transaction.error));
            transaction.addEventListener('abort', () => reject(transaction.error));
        });
    }

    applyPatternSnapshot(pattern) {
        if (!pattern) {
            return;
        }

        const snapshot = this.normalizeProjectPatterns([pattern])[0];
        if (!snapshot) {
            return;
        }

        this.activeScene = snapshot.sceneId;
        this.globalEffects = {
            ...this.globalEffects,
            ...snapshot.globalEffects
        };
        this.trackStates = this.normalizeTrackStates(snapshot.trackStates);
        this.sequenceConfig = this.normalizeSequenceConfig(snapshot.sequenceConfig);

        ['vocal', 'fx', 'texture', 'perc'].forEach((laneId) => {
            this.sampleState[laneId] = {
                ...this.createEmptySampleLaneState(),
                ...this.sampleState[laneId],
                ...snapshot.sampleSettings[laneId],
                buffer: this.sampleState[laneId].buffer,
                reverseBuffer: this.sampleState[laneId].reverseBuffer,
                blob: this.sampleState[laneId].blob
            };
        });

        this.projectMeta.key = snapshot.key || this.projectMeta.key;

        if (typeof snapshot.customCode === 'string') {
            this.dom.codeTextarea.value = snapshot.customCode;
        }

        this.userHasCustomCode = Boolean(snapshot.userHasCustomCode);
        this.defaultCode = this.buildDefaultCode();
        if (!this.userHasCustomCode) {
            this.dom.codeTextarea.value = this.defaultCode;
        }

        this.syncDomFromState();
        this.engine.syncMix();
        this.syncDefaultCodeFromControls();
        this.persistProject();
    }

    captureCurrentPattern() {
        this.projectPatterns = [
            ...this.projectPatterns,
            this.createPatternSnapshot()
        ];
        this.renderPatternRack();
        this.persistProject();
        this.showNotification('Current groove captured into the pattern rack.', 'success');
    }

    updatePatternFromCurrent(id) {
        this.projectPatterns = this.projectPatterns.map((pattern) => {
            if (pattern.id !== id) {
                return pattern;
            }

            const nextSnapshot = this.createPatternSnapshot(pattern.name);
            return {
                ...nextSnapshot,
                id: pattern.id,
                name: pattern.name,
                createdAt: pattern.createdAt,
                updatedAt: new Date().toISOString()
            };
        });
        this.renderPatternRack();
        this.persistProject();
        this.showNotification('Pattern snapshot refreshed from the current groove.', 'success');
    }

    duplicatePatternSnapshot(id) {
        const pattern = this.projectPatterns.find((candidate) => candidate.id === id);
        if (!pattern) {
            return;
        }

        const duplicated = {
            ...pattern,
            id: `pattern-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
            name: `${pattern.name} Copy`,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };
        this.projectPatterns = [...this.projectPatterns, duplicated];
        this.renderPatternRack();
        this.persistProject();
        this.showNotification('Pattern duplicated in the rack.', 'success');
    }

    deletePatternSnapshot(id) {
        this.projectPatterns = this.projectPatterns.filter((pattern) => pattern.id !== id);
        this.renderPatternRack();
        this.persistProject();
        this.showNotification('Pattern removed from the rack.', 'info');
    }

    renamePatternSnapshot(id, name) {
        this.projectPatterns = this.projectPatterns.map((pattern) => (
            pattern.id === id
                ? {
                    ...pattern,
                    name: name.trim() || pattern.name,
                    updatedAt: new Date().toISOString()
                }
                : pattern
        ));
        this.renderPatternRack();
        this.persistProject();
    }

    renderPatternRack() {
        if (!this.dom.patternRackList) {
            return;
        }

        this.dom.patternRackList.replaceChildren();

        if (!this.projectPatterns.length) {
            const helper = document.createElement('p');
            helper.className = 'helper-text';
            helper.textContent = 'No pattern snapshots yet. Capture the current groove when a section starts feeling worth keeping.';
            this.dom.patternRackList.appendChild(helper);
            return;
        }

        this.projectPatterns.forEach((pattern) => {
            const card = document.createElement('article');
            card.className = 'pattern-card';

            const header = document.createElement('div');
            header.className = 'pattern-card__header';

            const titleWrap = document.createElement('div');
            const nameInput = document.createElement('input');
            nameInput.type = 'text';
            nameInput.className = 'form-control pattern-card__name';
            nameInput.value = pattern.name;
            nameInput.addEventListener('change', (event) => this.renamePatternSnapshot(pattern.id, event.target.value));
            titleWrap.appendChild(nameInput);

            const meta = document.createElement('div');
            meta.className = 'pattern-card__meta';
            meta.textContent = `${this.scenePresets[pattern.sceneId]?.label || 'Pattern'} | ${pattern.globalEffects.tempo} BPM | ${pattern.key || this.projectMeta.key}`;

            header.append(titleWrap, meta);

            const details = document.createElement('div');
            details.className = 'pattern-card__details';
            const rhythmSummary = document.createElement('p');
            rhythmSummary.textContent = `Kick ${pattern.sequenceConfig.kickSteps.join(', ') || 'none'} | Snare ${pattern.sequenceConfig.snareSteps.join(', ') || 'none'} | Hats ${pattern.sequenceConfig.hatSteps.join(', ') || 'none'}`;
            const laneSummary = document.createElement('p');
            laneSummary.textContent = `Vocal ${pattern.sequenceConfig.vocalSteps.join(', ') || 'none'} | FX ${pattern.sequenceConfig.fxSteps.join(', ') || 'none'} | Texture ${pattern.sequenceConfig.textureSteps.join(', ') || 'none'} | Perc ${pattern.sequenceConfig.percSteps.join(', ') || 'none'}`;
            details.append(rhythmSummary, laneSummary);

            const actions = document.createElement('div');
            actions.className = 'pattern-card__actions';
            actions.append(
                this.createAssistantActionButton('Load', 'btn btn--secondary btn--sm', () => {
                    this.applyPatternSnapshot(pattern);
                    this.showNotification(`Loaded pattern "${pattern.name}".`, 'success');
                }),
                this.createAssistantActionButton('Refresh', 'btn btn--outline btn--sm', () => this.updatePatternFromCurrent(pattern.id)),
                this.createAssistantActionButton('Duplicate', 'btn btn--outline btn--sm', () => this.duplicatePatternSnapshot(pattern.id)),
                this.createAssistantActionButton('Delete', 'btn btn--outline btn--sm', () => this.deletePatternSnapshot(pattern.id))
            );

            card.append(header, details, actions);
            this.dom.patternRackList.appendChild(card);
        });
    }

    focusClipLibraryLane(laneId) {
        this.dom.sampleBrowserTargetLane.value = laneId;
        this.renderSampleBrowser();
        this.showNotification(`${this.getLaneLabel(laneId)} lane is now targeted in the template browser.`, 'info');
    }

    auditionClipLibraryLane(laneId) {
        const actions = {
            vocal: () => this.auditionVocalSample(),
            fx: () => this.auditionFxSample(),
            texture: () => this.auditionTextureSample(),
            perc: () => this.auditionPercSample()
        };

        return actions[laneId]?.() || Promise.resolve();
    }

    clearClipLibraryLane(laneId) {
        const actions = {
            vocal: () => this.clearVocalSample(),
            fx: () => this.clearFxSample(),
            texture: () => this.clearTextureSample(),
            perc: () => this.clearPercSample()
        };

        actions[laneId]?.();
    }

    renderClipLibrary() {
        if (!this.dom.clipLibraryList) {
            return;
        }

        this.dom.clipLibraryList.replaceChildren();

        this.getLoadedClipEntries().forEach((entry) => {
            const card = document.createElement('article');
            card.className = 'clip-library-card';

            const header = document.createElement('div');
            header.className = 'clip-library-card__header';

            const titleWrap = document.createElement('div');
            const title = document.createElement('h4');
            title.textContent = `${entry.label} Lane`;
            const summary = document.createElement('p');
            summary.textContent = entry.loaded
                ? entry.fileName
                : 'No imported clip yet. The built-in factory layer is active.';
            titleWrap.append(title, summary);

            const status = document.createElement('span');
            status.className = `clip-library-card__status${entry.loaded ? '' : ' is-empty'}`;
            status.textContent = entry.loaded ? 'Loaded Clip' : 'Factory Layer';
            header.append(titleWrap, status);

            const details = document.createElement('div');
            details.className = 'clip-library-card__details';
            const steps = document.createElement('p');
            steps.textContent = `Steps: ${entry.steps}`;
            const slice = document.createElement('p');
            slice.textContent = `Slice ${entry.start}% to ${entry.end}% | Rate ${entry.rate}%${entry.reverse ? ' | Reverse' : ''}`;
            details.append(steps, slice);

            const actions = document.createElement('div');
            actions.className = 'clip-library-card__actions';
            actions.append(
                this.createAssistantActionButton('Audition', 'btn btn--secondary btn--sm', () => {
                    this.auditionClipLibraryLane(entry.laneId).catch((error) => {
                        this.showNotification(`Clip audition failed: ${error.message}`, 'error');
                    });
                }),
                this.createAssistantActionButton('Aim Browser', 'btn btn--outline btn--sm', () => this.focusClipLibraryLane(entry.laneId)),
                this.createAssistantActionButton('Clear Lane', 'btn btn--outline btn--sm', () => this.clearClipLibraryLane(entry.laneId))
            );

            card.append(header, details, actions);
            this.dom.clipLibraryList.appendChild(card);
        });

        this.renderSessionOverview();
    }

    buildProjectJsonPreview() {
        return JSON.stringify(this.serializeProject(), null, 2);
    }

    renderExportPanel() {
        if (!this.dom.exportJsonTextarea) {
            return;
        }

        this.dom.exportJsonTextarea.value = this.buildProjectJsonPreview();
    }

    queueExportPanelRefresh() {
        if (!this.dom.exportJsonTextarea || this.exportPanelRefreshFrame) {
            return;
        }

        this.exportPanelRefreshFrame = window.requestAnimationFrame(() => {
            this.exportPanelRefreshFrame = null;
            this.renderExportPanel();
        });
    }

    downloadProjectJson() {
        const json = this.buildProjectJsonPreview();
        const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        const safeName = (this.projectMeta.name || 'strudel-session')
            .toLowerCase()
            .replace(/[^\w-]+/g, '-')
            .replace(/^-+|-+$/g, '');

        link.href = url;
        link.download = `${safeName || 'strudel-session'}-session.json`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
        this.showNotification('Session JSON downloaded.', 'success');
    }

    buildProjectRecord() {
        const snapshot = this.serializeProject();
        return {
            id: this.projectMeta.id,
            name: this.projectMeta.name,
            notes: this.projectMeta.notes,
            key: this.projectMeta.key,
            tempo: snapshot.globalEffects.tempo,
            patternCount: (snapshot.projectPatterns || []).length,
            createdAt: this.projectMeta.createdAt,
            updatedAt: snapshot.projectMeta.updatedAt,
            snapshot,
            sampleAssets: {
                vocal: this.sampleState.vocal.blob || null,
                fx: this.sampleState.fx.blob || null,
                texture: this.sampleState.texture.blob || null,
                perc: this.sampleState.perc.blob || null
            }
        };
    }

    async loadProjectLibrary() {
        const records = await this.getAllProjectRecords();
        this.projectLibrary = records.sort((left, right) => new Date(right.updatedAt) - new Date(left.updatedAt));
        this.renderProjectLibrary();
    }

    renderProjectLibrary() {
        if (!this.dom.projectLibraryList) {
            return;
        }

        this.dom.projectLibraryList.innerHTML = '';

        if (!this.projectLibrary.length) {
            this.dom.projectLibraryList.innerHTML = '<p class="helper-text">No local snapshots yet. Save one when a groove starts feeling worth keeping.</p>';
            return;
        }

        this.projectLibrary.forEach((record) => {
            const card = document.createElement('article');
            card.className = 'project-library-card';
            card.innerHTML = `
                <div class="project-library-card__body">
                    <div>
                        <h4>${this.escapeHtml(record.name)}</h4>
                        <p>${this.escapeHtml(record.notes || 'No notes yet.')}</p>
                    </div>
                    <div class="project-library-card__meta">
                        <span>${this.escapeHtml(record.key || record.snapshot?.projectMeta?.key || 'No key')} | ${record.tempo || record.snapshot?.globalEffects?.tempo || this.globalEffects.tempo} BPM</span>
                        <span>${record.patternCount || record.snapshot?.projectPatterns?.length || 0} patterns</span>
                        <span>Updated ${new Date(record.updatedAt).toLocaleString()}</span>
                    </div>
                </div>
                <div class="project-library-card__actions">
                    <button class="btn btn--secondary btn--sm project-load" type="button">Load</button>
                    <button class="btn btn--outline btn--sm project-delete" type="button">Delete</button>
                </div>
            `;

            card.querySelector('.project-load').addEventListener('click', () => {
                this.loadProjectSnapshot(record.id).catch((error) => {
                    console.error('Project load failed:', error);
                    this.showNotification(`Project load failed: ${error.message}`, 'error');
                });
            });

            card.querySelector('.project-delete').addEventListener('click', () => {
                this.deleteProjectSnapshot(record.id).catch((error) => {
                    console.error('Project delete failed:', error);
                    this.showNotification(`Project delete failed: ${error.message}`, 'error');
                });
            });

            this.dom.projectLibraryList.appendChild(card);
        });
    }

    async loadProjectSnapshot(id) {
        const record = await this.getProjectRecord(id);
        if (!record) {
            throw new Error('Snapshot not found.');
        }

        this.applyProject(record.snapshot);
        this.applyProjectSampleAssets(record.sampleAssets || {});
        this.persistProject();
        this.showNotification(`Loaded ${record.name}.`, 'success');
        this.renderStrudelStatus(`Loaded snapshot "${record.name}". Any saved sample files are now attached to the matching lanes.`, 'ready');
    }

    applyProjectSampleAssets(sampleAssets = {}) {
        ['vocal', 'fx', 'texture', 'perc'].forEach((laneId) => {
            const blob = sampleAssets[laneId] || null;
            if (blob) {
                this.sampleState[laneId].blob = blob;
                this.sampleState[laneId].buffer = null;
                this.sampleState[laneId].reverseBuffer = null;
                this.sampleState[laneId].mimeType = blob.type || this.sampleState[laneId].mimeType;
            }
        });

        this.updateSampleStatus();
        this.updateFxStatus();
        this.updateTextureStatus();
        this.updatePercStatus();
    }

    async deleteProjectSnapshot(id) {
        await this.deleteProjectRecord(id);
        if (this.projectMeta.id === id) {
            this.showNotification('Current snapshot deleted from the shelf. Your draft is still open.', 'info');
        } else {
            this.showNotification('Snapshot deleted from the shelf.', 'info');
        }
        await this.loadProjectLibrary();
    }

    newProject() {
        this.projectMeta = this.createDefaultProjectMeta();
        this.trackStates = this.createDefaultTrackStates();
        this.globalEffects = this.createDefaultGlobalEffects();
        this.sequenceConfig = this.createDefaultSequenceConfig();
        this.sampleState = {
            vocal: this.createEmptySampleLaneState(),
            fx: this.createEmptySampleLaneState(),
            texture: this.createEmptySampleLaneState(),
            perc: this.createEmptySampleLaneState()
        };
        this.arrangement = this.createDefaultArrangement();
        this.projectPatterns = [];
        this.activeScene = 'main';
        this.currentTime = 0;
        this.currentBeat = 1;
        this.currentCycle = 0;
        this.userHasCustomCode = false;
        this.workspaceLayout = 'studio';
        this.assistantVisible = false;
        this.defaultCode = this.buildDefaultCode();
        this.dom.codeTextarea.value = this.defaultCode;
        this.syncDomFromState();
        this.renderWorkspaceState();
        this.updateVolumeDisplays();
        this.updateEffectDisplays();
        this.updateSampleStatus();
        this.updateFxStatus();
        this.updateTextureStatus();
        this.updatePercStatus();
        this.engine.syncMix();
        this.persistProject();
        this.showNotification('Started a fresh project.', 'success');
    }

    async duplicateProject() {
        this.projectMeta = {
            ...this.projectMeta,
            id: `project-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
            name: `${this.projectMeta.name} Copy`,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };
        this.persistProject();
        await this.saveProjectToBrowser();
    }

    async blobToDataUrl(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.addEventListener('load', () => resolve(reader.result));
            reader.addEventListener('error', () => reject(reader.error));
            reader.readAsDataURL(blob);
        });
    }

    async dataUrlToBlob(dataUrl) {
        const response = await fetch(dataUrl);
        return response.blob();
    }

    renderSampleBrowser() {
        if (!this.dom.sampleBrowserList) {
            return;
        }

        const query = (this.dom.sampleBrowserSearch.value || '').trim().toLowerCase();
        const targetLane = this.dom.sampleBrowserTargetLane.value;
        const presets = this.sampleBrowserPresets.filter((preset) => {
            if (!query) {
                return true;
            }

            return [preset.name, preset.category, preset.description].some((value) => value.toLowerCase().includes(query));
        });

        this.dom.sampleBrowserList.innerHTML = '';

        presets.forEach((preset) => {
            const card = document.createElement('article');
            card.className = 'sample-browser-card';
            const defaultLane = this.getLaneLabel(preset.laneDefaults.laneId);
            card.innerHTML = `
                <div class="sample-browser-card__header">
                    <div>
                        <span class="sample-browser-card__category">${preset.category}</span>
                        <h4>${preset.name}</h4>
                        <p>${preset.description}</p>
                    </div>
                    <div class="sample-browser-card__meta">
                        <span>Suggested lane: ${defaultLane}</span>
                    </div>
                </div>
                <div class="sample-browser-card__footer">
                    <span>Apply to ${this.getLaneLabel(targetLane)} lane</span>
                    <button class="btn btn--secondary btn--sm sample-browser-apply" type="button">Apply Template</button>
                </div>
            `;

            card.querySelector('.sample-browser-apply').addEventListener('click', () => this.applySampleBrowserPreset(preset.id));
            this.dom.sampleBrowserList.appendChild(card);
        });

        if (!presets.length) {
            this.dom.sampleBrowserList.innerHTML = '<p class="helper-text">No browser templates matched that search.</p>';
        }
    }

    applySampleBrowserPreset(presetId) {
        const preset = this.sampleBrowserPresets.find((candidate) => candidate.id === presetId);
        if (!preset) {
            return;
        }

        const laneId = this.dom.sampleBrowserTargetLane.value || preset.laneDefaults.laneId;
        const lane = this.sampleState[laneId];
        const sequenceKey = laneId === 'perc' ? 'percSteps' : `${laneId}Steps`;

        this.sequenceConfig[sequenceKey] = [...preset.laneDefaults.steps];
        lane.start = preset.laneDefaults.start;
        lane.end = preset.laneDefaults.end;
        lane.rate = preset.laneDefaults.rate;
        lane.reverse = preset.laneDefaults.reverse;

        this.syncDomFromState();
        this.updateLaneStatus(laneId);
        this.markSceneCustom();
        this.syncDefaultCodeFromControls();
        this.persistProject();
        this.showNotification(`${preset.name} applied to the ${this.getLaneLabel(laneId).toLowerCase()} lane.`, 'success');
    }

    restoreAssistantSettings() {
        try {
            const raw = localStorage.getItem(this.assistantSettingsStorageKey);
            if (raw) {
                this.assistantSettings = {
                    ...this.assistantSettings,
                    ...JSON.parse(raw)
                };
            }
        } catch (error) {
            console.warn('Could not restore assistant settings:', error);
        }

        this.dom.assistantEndpointInput.value = this.assistantSettings.endpoint;
        this.dom.assistantModelInput.value = this.assistantSettings.model;
        this.dom.assistantSystemPrompt.value = this.assistantSettings.systemPrompt;
    }

    persistAssistantSettings() {
        this.assistantSettings = {
            endpoint: this.dom.assistantEndpointInput.value.trim(),
            model: this.dom.assistantModelInput.value.trim(),
            systemPrompt: this.dom.assistantSystemPrompt.value.trim()
        };

        localStorage.setItem(this.assistantSettingsStorageKey, JSON.stringify(this.assistantSettings));
    }

    escapeHtml(value) {
        return String(value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    sanitizeCommentText(value) {
        return String(value ?? '')
            .replace(/[\r\n]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    extractCodeBlock(text) {
        const match = text.match(/```(?:[\w-]+)?\s*([\s\S]*?)```/);
        return match ? match[1].trim() : '';
    }

    normalizeAssistantMessages(messages = []) {
        if (!Array.isArray(messages)) {
            return [];
        }

        return messages
            .map((message) => ({
                role: message?.role === 'assistant' ? 'assistant' : 'user',
                content: String(message?.content || '').trim().slice(0, this.maxAssistantMessageLength)
            }))
            .filter((message) => message.content)
            .slice(-this.maxAssistantMessages);
    }

    pushAssistantMessage(role, content) {
        this.assistantMessages = this.normalizeAssistantMessages([
            ...this.assistantMessages,
            { role, content }
        ]);
        this.renderAssistantMessages();
        this.persistProject();
    }

    clearAssistantConversation(notify = true) {
        this.assistantMessages = [];
        this.dom.assistantPromptInput.value = '';
        this.renderAssistantMessages();
        this.setAssistantStatus('Local endpoint idle.');
        this.persistProject();
        if (notify) {
            this.showNotification('Assistant chat cleared for this project.', 'info');
        }
    }

    isLikelyAssistantCodeLine(line) {
        const trimmed = String(line || '').trim();
        if (!trimmed) {
            return false;
        }

        return /^(?:\.|\/\/|let\s+\w+|const\s+\w+|stack\(|arrange\(|note\(|s\(|sound\(|hush\b|setcpm\b|await\b|[a-zA-Z_]+\s*=)/.test(trimmed);
    }

    extractAssistantCodeSuggestion(text) {
        const fenced = this.extractCodeBlock(text);
        if (fenced) {
            return fenced;
        }

        const trimmed = String(text || '').trim();
        if (!trimmed) {
            return '';
        }

        if (this.isLikelyAssistantCodeLine(trimmed)) {
            return trimmed;
        }

        const lines = trimmed.split(/\r?\n/);
        const firstCodeIndex = lines.findIndex((line) => this.isLikelyAssistantCodeLine(line));
        if (firstCodeIndex === -1) {
            return '';
        }

        const candidateLines = lines.slice(firstCodeIndex);
        const nonEmptyLines = candidateLines.filter((line) => line.trim());
        const codeLikeLines = nonEmptyLines.filter((line) => this.isLikelyAssistantCodeLine(line));

        if (!nonEmptyLines.length || codeLikeLines.length < Math.ceil(nonEmptyLines.length * 0.6)) {
            return '';
        }

        return candidateLines.join('\n').trim();
    }

    createAssistantActionButton(label, className, onClick) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = className;
        button.textContent = label;
        button.addEventListener('click', onClick);
        return button;
    }

    renderAssistantMessages() {
        if (!this.dom.assistantMessages) {
            return;
        }

        this.dom.assistantMessages.replaceChildren();

        if (!this.assistantMessages.length) {
            const helper = document.createElement('p');
            helper.className = 'helper-text';
            helper.textContent = 'Ask the local assistant to explain the current code, write a new scene, or reshape the groove. Use Ctrl+Enter to send.';
            this.dom.assistantMessages.appendChild(helper);
            return;
        }

        this.assistantMessages.forEach((message, index) => {
            const article = document.createElement('article');
            article.className = `assistant-message assistant-message--${message.role}`;

            const label = document.createElement('div');
            label.className = 'assistant-message__label';
            label.textContent = message.role === 'assistant' ? 'Assistant' : 'You';

            const content = document.createElement('div');
            content.className = 'assistant-message__content';
            content.textContent = message.content;
            article.append(label, content);

            const codeBlock = message.role === 'assistant' ? this.extractAssistantCodeSuggestion(message.content) : '';
            if (codeBlock) {
                const codePreview = document.createElement('pre');
                codePreview.className = 'assistant-message__code';

                const codeElement = document.createElement('code');
                codeElement.textContent = codeBlock;
                codePreview.appendChild(codeElement);
                article.appendChild(codePreview);

                const actions = document.createElement('div');
                actions.className = 'assistant-message__actions';
                actions.append(
                    this.createAssistantActionButton('Replace Code', 'btn btn--secondary btn--sm', () => {
                        this.applyAssistantCode(codeBlock, 'replace').catch((error) => {
                            this.showNotification(`Assistant apply failed: ${error.message}`, 'error');
                        });
                    }),
                    this.createAssistantActionButton('Insert At Cursor', 'btn btn--outline btn--sm', () => {
                        this.applyAssistantCode(codeBlock, 'insert').catch((error) => {
                            this.showNotification(`Assistant apply failed: ${error.message}`, 'error');
                        });
                    }),
                    this.createAssistantActionButton('Append Below', 'btn btn--outline btn--sm', () => {
                        this.applyAssistantCode(codeBlock, 'append').catch((error) => {
                            this.showNotification(`Assistant apply failed: ${error.message}`, 'error');
                        });
                    }),
                    this.createAssistantActionButton('Replace + Update', 'btn btn--secondary btn--sm', () => {
                        this.applyAssistantCode(codeBlock, 'replace-update').catch((error) => {
                            this.showNotification(`Assistant apply failed: ${error.message}`, 'error');
                        });
                    }),
                    this.createAssistantActionButton('Copy Code', 'btn btn--outline btn--sm', () => {
                        this.copyText(codeBlock)
                            .then(() => this.showNotification('Assistant code copied.', 'success'))
                            .catch((error) => this.showNotification(`Could not copy assistant code: ${error.message}`, 'error'));
                    })
                );
                article.appendChild(actions);
            }

            this.dom.assistantMessages.appendChild(article);
            if (index === this.assistantMessages.length - 1) {
                article.scrollIntoView({ block: 'end' });
            }
        });
    }

    setAssistantStatus(message) {
        if (this.dom.assistantStatus) {
            this.dom.assistantStatus.textContent = message;
        }
    }

    isLocalEndpoint(endpoint) {
        const parsed = new URL(endpoint);
        const host = parsed.hostname;
        return ['127.0.0.1', 'localhost', '0.0.0.0', '::1'].includes(host);
    }

    buildAssistantBaseEndpoint(endpoint) {
        const trimmed = endpoint.replace(/\/+$/, '');
        if (trimmed.endsWith('/chat/completions')) {
            return trimmed.slice(0, -'/chat/completions'.length);
        }
        if (trimmed.endsWith('/models')) {
            return trimmed.slice(0, -'/models'.length);
        }
        return trimmed;
    }

    buildAssistantEndpoint(endpoint) {
        return `${this.buildAssistantBaseEndpoint(endpoint)}/chat/completions`;
    }

    buildAssistantModelsEndpoint(endpoint) {
        return `${this.buildAssistantBaseEndpoint(endpoint)}/models`;
    }

    isLikelyOllamaEndpoint(endpoint) {
        try {
            const parsed = new URL(this.buildAssistantBaseEndpoint(endpoint));
            return parsed.port === '11434';
        } catch (_) {
            return false;
        }
    }

    extractAssistantModels(payload) {
        if (Array.isArray(payload?.data)) {
            return payload.data
                .map((model) => model?.id || model?.name)
                .filter(Boolean);
        }

        if (Array.isArray(payload?.models)) {
            return payload.models
                .map((model) => model?.name || model?.model || model?.id)
                .filter(Boolean);
        }

        return [];
    }

    async fetchAssistantModels(endpoint) {
        const response = await fetch(this.buildAssistantModelsEndpoint(endpoint));
        if (!response.ok) {
            throw new Error(`Local model lookup failed with ${response.status}`);
        }

        const payload = await response.json();
        return this.extractAssistantModels(payload);
    }

    async testAssistantConnection(options = {}) {
        const { silent = false } = options;
        this.persistAssistantSettings();
        const endpoint = this.assistantSettings.endpoint;

        if (!endpoint) {
            throw new Error('Enter a local endpoint first.');
        }

        if (!this.isLocalEndpoint(endpoint)) {
            throw new Error('Only localhost endpoints are allowed for this assistant.');
        }

        const models = await this.fetchAssistantModels(endpoint);
        if (!models.length) {
            throw new Error('The local endpoint responded, but no models were listed.');
        }

        if (!this.assistantSettings.model || !models.includes(this.assistantSettings.model)) {
            this.dom.assistantModelInput.value = models[0];
            this.persistAssistantSettings();
        }

        this.setAssistantStatus(`Connected to local AI. Model ready: ${this.assistantSettings.model}.`);
        if (!silent) {
            this.showNotification(`Connected to local AI: ${this.assistantSettings.model}`, 'success');
        }

        return {
            endpoint: this.assistantSettings.endpoint,
            models
        };
    }

    async detectLocalAssistant(options = {}) {
        const { silent = false } = options;
        const candidates = [
            this.dom.assistantEndpointInput.value.trim(),
            'http://127.0.0.1:11434/v1',
            'http://127.0.0.1:1234/v1'
        ].filter(Boolean);

        for (const endpoint of new Set(candidates)) {
            try {
                if (!this.isLocalEndpoint(endpoint)) {
                    continue;
                }

                const models = await this.fetchAssistantModels(endpoint);
                if (!models.length) {
                    continue;
                }

                this.dom.assistantEndpointInput.value = endpoint;
                this.dom.assistantModelInput.value = models[0];
                this.persistAssistantSettings();
                this.setAssistantStatus(`Detected local AI at ${endpoint}. Model ready: ${models[0]}.`);
                if (!silent) {
                    this.showNotification(`Detected local AI: ${models[0]}`, 'success');
                }

                return {
                    endpoint,
                    models
                };
            } catch (_) {
                // move to the next local candidate
            }
        }

        throw new Error('No local AI endpoint was detected. Start Ollama or LM Studio and try again.');
    }

    async bootstrapAssistantConnection() {
        try {
            await this.testAssistantConnection({ silent: true });
            return;
        } catch (_) {
            // fall through to discovery
        }

        try {
            await this.detectLocalAssistant({ silent: true });
        } catch (_) {
            this.setAssistantStatus('No local AI endpoint detected yet. Start Ollama or LM Studio, then test again.');
        }
    }

    buildAssistantContext(prompt) {
        const arrangement = this.arrangement.map((section) => `${section.name}:${section.bars}b:${section.sceneId}`).join(' | ');
        const laneSummary = [
            `vocal ${this.sequenceConfig.vocalSteps.join(',') || 'none'}`,
            `fx ${this.sequenceConfig.fxSteps.join(',') || 'none'}`,
            `texture ${this.sequenceConfig.textureSteps.join(',') || 'none'}`,
            `perc ${this.sequenceConfig.percSteps.join(',') || 'none'}`
        ].join(' | ');
        const codeSnippet = this.dom.codeTextarea.value.length > 2400
            ? `${this.dom.codeTextarea.value.slice(0, 2400)}\n// ...truncated for local model speed`
            : this.dom.codeTextarea.value;

        return `Studio context:
project=${this.projectMeta.name}
scene=${this.activeScene}
tempo=${this.globalEffects.tempo}
arrangement=${arrangement}
lane_steps=${laneSummary}

Current Strudel code:
\`\`\`js
${codeSnippet}
\`\`\`

User request:
${prompt}`;
    }

    buildAssistantSystemPrompt() {
        const basePrompt = this.assistantSettings.systemPrompt?.trim() || this.createDefaultAssistantSettings().systemPrompt;
        return `${basePrompt}\n\nReturn only the final helpful answer in message.content. Do not leave the answer only in a reasoning field. Keep it concise unless code is requested. When suggesting Strudel or JavaScript changes, include the exact code in a fenced code block.`;
    }

    extractAssistantContent(payload) {
        const contentCandidate = payload?.choices?.[0]?.message?.content
            ?? payload?.message?.content
            ?? payload?.response;

        if (Array.isArray(contentCandidate)) {
            return contentCandidate
                .map((part) => part?.text || part?.content || '')
                .join('\n')
                .trim();
        }

        if (typeof contentCandidate === 'string') {
            return contentCandidate.trim();
        }

        return '';
    }

    async sendAssistantPrompt() {
        const prompt = this.dom.assistantPromptInput.value.trim();
        if (!prompt || this.assistantBusy) {
            return;
        }

        this.persistAssistantSettings();
        const endpoint = this.assistantSettings.endpoint;
        if (!endpoint) {
            throw new Error('Enter a local endpoint first.');
        }

        if (!this.isLocalEndpoint(endpoint)) {
            throw new Error('Only localhost endpoints are allowed for this assistant.');
        }

        this.assistantBusy = true;
        this.dom.assistantSendBtn.disabled = true;
        this.pushAssistantMessage('user', prompt);
        this.setAssistantStatus('Sending to local endpoint...');

        try {
            const requestBody = {
                model: this.assistantSettings.model,
                temperature: 0.4,
                max_tokens: 220,
                stream: false,
                messages: [
                    { role: 'system', content: this.buildAssistantSystemPrompt() },
                    ...this.assistantMessages.slice(-6).map((message) => ({
                        role: message.role,
                        content: message.role === 'user' ? this.buildAssistantContext(message.content) : message.content
                    }))
                ]
            };

            if (this.isLikelyOllamaEndpoint(endpoint)) {
                requestBody.reasoning = { effort: 'none' };
            }

            const response = await fetch(this.buildAssistantEndpoint(endpoint), {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(requestBody)
            });

            if (!response.ok) {
                throw new Error(`Local endpoint returned ${response.status}.`);
            }

            const payload = await response.json();
            const content = this.extractAssistantContent(payload) || 'The local model returned no final text. Try another model or a shorter prompt.';
            this.pushAssistantMessage('assistant', content);
            this.dom.assistantPromptInput.value = '';
            this.setAssistantStatus('Response ready.');
            this.persistProject();
        } finally {
            this.assistantBusy = false;
            this.dom.assistantSendBtn.disabled = false;
        }
    }

    insertAssistantCodeAtCursor(code) {
        const textarea = this.dom.codeTextarea;
        const start = Number.isFinite(textarea.selectionStart) ? textarea.selectionStart : textarea.value.length;
        const end = Number.isFinite(textarea.selectionEnd) ? textarea.selectionEnd : textarea.value.length;
        const prefix = textarea.value.slice(0, start);
        const suffix = textarea.value.slice(end);
        const needsLeadingBreak = prefix && !prefix.endsWith('\n');
        const needsTrailingBreak = suffix && !suffix.startsWith('\n');
        const insertion = `${needsLeadingBreak ? '\n' : ''}${code}${needsTrailingBreak ? '\n' : ''}`;
        const nextValue = `${prefix}${insertion}${suffix}`;
        const nextCaret = (prefix + insertion).length;

        textarea.value = nextValue;
        textarea.focus();
        textarea.setSelectionRange(nextCaret, nextCaret);
    }

    async applyAssistantCode(code, mode) {
        const updateLive = mode.endsWith('-update');
        const normalizedMode = updateLive ? mode.replace(/-update$/, '') : mode;

        if (normalizedMode === 'replace') {
            this.dom.codeTextarea.value = code;
        } else if (normalizedMode === 'insert') {
            this.insertAssistantCodeAtCursor(code);
        } else {
            this.dom.codeTextarea.value = `${this.dom.codeTextarea.value.trim()}\n\n${code}`;
        }

        this.userHasCustomCode = true;
        this.setWorkspaceLayout('code');
        this.persistProject();

        if (updateLive) {
            await this.updateCode();
            this.showNotification('Assistant code applied and sent to the editor.', 'success');
            return;
        }

        this.showNotification('Assistant code moved into the editor.', 'success');
    }

    registerPwaSupport() {
        if (window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone) {
            this.dom.installAppBtn.textContent = 'Installed';
            this.dom.installAppBtn.disabled = true;
            this.dom.installAppBtn.title = 'This browser profile already has the studio installed as an app.';
        }

        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.register('sw.js').catch((error) => {
                console.warn('Service worker registration failed:', error);
            });
        }

        window.addEventListener('beforeinstallprompt', (event) => {
            event.preventDefault();
            this.pendingInstallPrompt = event;
            this.dom.installAppBtn.disabled = false;
            this.dom.installAppBtn.textContent = 'Install App';
            this.dom.installAppBtn.title = 'Install the studio as a standalone desktop-style web app.';
        });

        window.addEventListener('appinstalled', () => {
            this.pendingInstallPrompt = null;
            this.dom.installAppBtn.textContent = 'Installed';
            this.dom.installAppBtn.disabled = true;
            this.dom.installAppBtn.title = 'This browser profile already has the studio installed as an app.';
        });
    }

    async promptInstall() {
        if (!this.pendingInstallPrompt) {
            this.showNotification('Install prompt not available yet in this browser.', 'info');
            return;
        }

        await this.pendingInstallPrompt.prompt();
        this.pendingInstallPrompt = null;
    }

    renderArrangementTimeline() {
        if (!this.dom.arrangementTimeline) {
            return;
        }

        const container = this.dom.arrangementTimeline;
        const totalBars = this.getArrangementBars();
        const barDuration = this.getBarDuration();
        let elapsedBars = 0;

        container.innerHTML = '';

        this.arrangement.forEach((section) => {
            const sceneMeta = this.sceneStyles[section.sceneId] || this.sceneStyles.main;
            const startTime = elapsedBars * barDuration;
            const endTime = (elapsedBars + section.bars) * barDuration;
            const isCurrent = this.currentTime >= startTime && this.currentTime < endTime;

            const sectionElement = document.createElement('button');
            sectionElement.type = 'button';
            sectionElement.className = 'timeline-section';
            sectionElement.style.width = `${(section.bars / totalBars) * 100}%`;
            sectionElement.style.setProperty('--section-color', sceneMeta.color);
            sectionElement.style.setProperty('--section-glow', sceneMeta.glow);
            sectionElement.dataset.scene = section.sceneId;
            sectionElement.dataset.sectionId = section.id;
            sectionElement.draggable = true;
            sectionElement.title = 'Drag to reorder. Use the right-side grip to resize bars.';

            if (section.sceneId === this.activeScene) {
                sectionElement.classList.add('is-active-scene');
            }

            if (isCurrent && this.isPlaying) {
                sectionElement.classList.add('is-current');
            }

            const label = document.createElement('span');
            label.className = 'section-label';
            label.textContent = section.name;

            const time = document.createElement('span');
            time.className = 'section-time';
            time.textContent = `${this.formatTime(startTime)}-${this.formatTime(endTime)}`;

            const meta = document.createElement('span');
            meta.className = 'section-meta';
            meta.textContent = `${section.bars} bars | ${this.scenePresets[section.sceneId]?.label || 'Scene'}`;

            const resizeHandle = document.createElement('span');
            resizeHandle.className = 'timeline-resize-handle';
            resizeHandle.setAttribute('role', 'presentation');
            resizeHandle.addEventListener('pointerdown', (event) => this.startTimelineResize(section.id, event));

            sectionElement.append(label, time, meta, resizeHandle);

            sectionElement.addEventListener('click', () => this.applyScenePreset(section.sceneId));
            sectionElement.addEventListener('dragstart', (event) => this.handleTimelineDragStart(event, section.id));
            sectionElement.addEventListener('dragover', (event) => this.handleTimelineDragOver(event));
            sectionElement.addEventListener('dragleave', (event) => this.handleTimelineDragLeave(event));
            sectionElement.addEventListener('drop', (event) => this.handleTimelineDrop(event, section.id));
            sectionElement.addEventListener('dragend', (event) => this.handleTimelineDragEnd(event));
            container.appendChild(sectionElement);

            elapsedBars += section.bars;
        });

        const marker = document.createElement('div');
        marker.id = 'timelineMarker';
        marker.className = 'timeline-marker';
        container.appendChild(marker);
        this.dom.timelineMarker = marker;
        this.updateTimelineMarker();
    }

    renderArrangementEditor() {
        if (!this.dom.arrangementEditor) {
            return;
        }

        const editor = this.dom.arrangementEditor;
        editor.innerHTML = '';

        this.arrangement.forEach((section, index) => {
            const row = document.createElement('div');
            row.className = 'arrangement-row';
            const indexField = document.createElement('div');
            indexField.className = 'arrangement-field arrangement-field--index';
            indexField.textContent = `#${index + 1}`;

            const nameLabel = document.createElement('label');
            nameLabel.className = 'arrangement-field';
            const nameText = document.createElement('span');
            nameText.className = 'form-label';
            nameText.textContent = 'Name';
            const nameInput = document.createElement('input');
            nameInput.className = 'form-control arrangement-name';
            nameInput.type = 'text';
            nameInput.value = section.name;
            nameLabel.append(nameText, nameInput);

            const sceneLabel = document.createElement('label');
            sceneLabel.className = 'arrangement-field';
            const sceneText = document.createElement('span');
            sceneText.className = 'form-label';
            sceneText.textContent = 'Scene';
            const sceneSelect = document.createElement('select');
            sceneSelect.className = 'form-control arrangement-scene';

            Object.entries(this.scenePresets).forEach(([sceneId, scene]) => {
                const option = document.createElement('option');
                option.value = sceneId;
                option.textContent = scene.label;
                option.selected = sceneId === section.sceneId;
                sceneSelect.appendChild(option);
            });

            sceneLabel.append(sceneText, sceneSelect);

            const barsLabel = document.createElement('label');
            barsLabel.className = 'arrangement-field arrangement-field--bars';
            const barsText = document.createElement('span');
            barsText.className = 'form-label';
            barsText.textContent = 'Bars';
            const barsInput = document.createElement('input');
            barsInput.className = 'form-control arrangement-bars';
            barsInput.type = 'number';
            barsInput.min = '1';
            barsInput.value = String(section.bars);
            barsLabel.append(barsText, barsInput);

            const actions = document.createElement('div');
            actions.className = 'arrangement-actions';
            const previewButton = document.createElement('button');
            previewButton.className = 'btn btn--secondary btn--sm arrangement-preview';
            previewButton.type = 'button';
            previewButton.textContent = 'Load';
            const upButton = document.createElement('button');
            upButton.className = 'btn btn--outline btn--sm arrangement-move-up';
            upButton.type = 'button';
            upButton.textContent = 'Up';
            upButton.disabled = index === 0;
            upButton.title = index === 0 ? 'Already the first section.' : 'Move this section earlier.';
            const downButton = document.createElement('button');
            downButton.className = 'btn btn--outline btn--sm arrangement-move-down';
            downButton.type = 'button';
            downButton.textContent = 'Down';
            downButton.disabled = index === this.arrangement.length - 1;
            downButton.title = index === this.arrangement.length - 1 ? 'Already the final section.' : 'Move this section later.';
            const duplicateButton = document.createElement('button');
            duplicateButton.className = 'btn btn--outline btn--sm arrangement-duplicate';
            duplicateButton.type = 'button';
            duplicateButton.textContent = 'Duplicate';
            const removeButton = document.createElement('button');
            removeButton.className = 'btn btn--outline btn--sm arrangement-remove';
            removeButton.type = 'button';
            removeButton.textContent = 'Remove';
            actions.append(upButton, downButton, duplicateButton, previewButton, removeButton);

            row.append(indexField, nameLabel, sceneLabel, barsLabel, actions);

            nameInput.addEventListener('change', (event) => {
                this.updateArrangementSection(section.id, 'name', event.target.value);
            });

            sceneSelect.addEventListener('change', (event) => {
                this.updateArrangementSection(section.id, 'sceneId', event.target.value);
            });

            barsInput.addEventListener('change', (event) => {
                this.updateArrangementSection(section.id, 'bars', event.target.value);
            });

            upButton.addEventListener('click', () => this.moveArrangementSection(section.id, -1));
            downButton.addEventListener('click', () => this.moveArrangementSection(section.id, 1));
            duplicateButton.addEventListener('click', () => this.duplicateArrangementSection(section.id));
            previewButton.addEventListener('click', () => this.applyScenePreset(section.sceneId));
            removeButton.addEventListener('click', () => this.removeArrangementSection(section.id));

            editor.appendChild(row);
        });
    }

    applyStructureTemplate(templateId) {
        const template = this.structureTemplates[templateId];
        if (!template) {
            return;
        }

        this.arrangement = template.map((section) => this.createArrangementSection(section.sceneId, section.name, section.bars));
        this.currentTime = 0;
        this.renderArrangementTimeline();
        this.renderArrangementEditor();
        this.refreshTimelineMetrics();
        this.syncDefaultCodeFromControls();
        this.persistProject();
        this.showNotification(`${templateId.replace(/-/g, ' ')} structure loaded.`, 'success');
    }

    startTimelineResize(sectionId, event) {
        event.preventDefault();
        event.stopPropagation();
        const section = this.arrangement.find((candidate) => candidate.id === sectionId);
        const timelineRect = this.dom.arrangementTimeline?.getBoundingClientRect();
        if (!section || !timelineRect?.width) {
            return;
        }

        this.arrangementInteraction = {
            type: 'resize',
            sectionId,
            startX: event.clientX,
            startBars: section.bars,
            lastBars: section.bars,
            totalBars: this.getArrangementBars(),
            timelineWidth: timelineRect.width
        };
        document.body.classList.add('arrangement-resizing');
    }

    handleTimelinePointerMove(event) {
        if (!this.arrangementInteraction || this.arrangementInteraction.type !== 'resize') {
            return;
        }

        const deltaX = event.clientX - this.arrangementInteraction.startX;
        const deltaBars = Math.round((deltaX / Math.max(1, this.arrangementInteraction.timelineWidth)) * this.arrangementInteraction.totalBars);
        const nextBars = Math.max(1, this.arrangementInteraction.startBars + deltaBars);
        if (nextBars === this.arrangementInteraction.lastBars) {
            return;
        }

        this.arrangementInteraction.lastBars = nextBars;
        this.arrangement = this.arrangement.map((section) => (
            section.id === this.arrangementInteraction.sectionId
                ? { ...section, bars: nextBars }
                : section
        ));
        this.renderArrangementTimeline();
        this.renderArrangementEditor();
        this.refreshTimelineMetrics();
        this.syncDefaultCodeFromControls();
    }

    finishTimelineInteraction() {
        if (!this.arrangementInteraction) {
            return;
        }

        const didResize = this.arrangementInteraction.type === 'resize'
            && this.arrangementInteraction.startBars !== this.arrangementInteraction.lastBars;
        this.arrangementInteraction = null;
        document.body.classList.remove('arrangement-resizing');

        if (didResize) {
            this.persistProject();
            this.showNotification('Section length updated from the timeline handle.', 'success');
        }
    }

    handleTimelineDragStart(event, sectionId) {
        this.draggedArrangementSectionId = sectionId;
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', sectionId);
        event.currentTarget.classList.add('is-dragging');
    }

    handleTimelineDragOver(event) {
        event.preventDefault();
        const target = event.currentTarget;
        const rect = target.getBoundingClientRect();
        const placeAfter = event.clientX > rect.left + (rect.width / 2);
        target.classList.toggle('drop-before', !placeAfter);
        target.classList.toggle('drop-after', placeAfter);
    }

    handleTimelineDragLeave(event) {
        event.currentTarget.classList.remove('drop-before', 'drop-after');
    }

    handleTimelineDrop(event, targetId) {
        event.preventDefault();
        const draggedId = event.dataTransfer.getData('text/plain') || this.draggedArrangementSectionId;
        event.currentTarget.classList.remove('drop-before', 'drop-after');
        if (!draggedId || draggedId === targetId) {
            return;
        }

        const targetRect = event.currentTarget.getBoundingClientRect();
        const insertAfter = event.clientX > targetRect.left + (targetRect.width / 2);
        this.reorderArrangementSectionByDrop(draggedId, targetId, insertAfter);
    }

    handleTimelineDragEnd(event) {
        this.draggedArrangementSectionId = null;
        event.currentTarget.classList.remove('is-dragging');
        document.querySelectorAll('.timeline-section').forEach((section) => {
            section.classList.remove('drop-before', 'drop-after', 'is-dragging');
        });
    }

    reorderArrangementSectionByDrop(draggedId, targetId, insertAfter = false) {
        const nextArrangement = [...this.arrangement];
        const fromIndex = nextArrangement.findIndex((section) => section.id === draggedId);
        const targetIndex = nextArrangement.findIndex((section) => section.id === targetId);
        if (fromIndex === -1 || targetIndex === -1) {
            return;
        }

        const [dragged] = nextArrangement.splice(fromIndex, 1);
        const rawInsertIndex = nextArrangement.findIndex((section) => section.id === targetId) + (insertAfter ? 1 : 0);
        nextArrangement.splice(rawInsertIndex, 0, dragged);
        this.arrangement = nextArrangement;
        this.renderArrangementTimeline();
        this.renderArrangementEditor();
        this.refreshTimelineMetrics();
        this.syncDefaultCodeFromControls();
        this.persistProject();
        this.showNotification('Arrangement reordered directly from the timeline.', 'success');
    }

    updateArrangementSection(sectionId, field, value) {
        this.arrangement = this.arrangement.map((section) => {
            if (section.id !== sectionId) {
                return section;
            }

            if (field === 'bars') {
                const bars = Number.parseInt(value, 10);
                return {
                    ...section,
                    bars: Number.isFinite(bars) && bars > 0 ? bars : section.bars
                };
            }

            if (field === 'sceneId') {
                const nextSceneId = this.scenePresets[value] ? value : section.sceneId;
                const nextDefaultName = this.scenePresets[nextSceneId]?.label || section.name;
                const nameWasSceneLabel = section.name === (this.scenePresets[section.sceneId]?.label || section.name);

                return {
                    ...section,
                    sceneId: nextSceneId,
                    name: nameWasSceneLabel ? nextDefaultName : section.name
                };
            }

            if (field === 'name') {
                return {
                    ...section,
                    name: value || section.name
                };
            }

            return section;
        });

        this.renderArrangementTimeline();
        this.renderArrangementEditor();
        this.refreshTimelineMetrics();
        this.syncDefaultCodeFromControls();
        this.persistProject();
    }

    moveArrangementSection(sectionId, direction) {
        const index = this.arrangement.findIndex((section) => section.id === sectionId);
        const nextIndex = index + direction;

        if (index === -1 || nextIndex < 0 || nextIndex >= this.arrangement.length) {
            return;
        }

        const nextArrangement = [...this.arrangement];
        const [section] = nextArrangement.splice(index, 1);
        nextArrangement.splice(nextIndex, 0, section);
        this.arrangement = nextArrangement;
        this.renderArrangementTimeline();
        this.renderArrangementEditor();
        this.refreshTimelineMetrics();
        this.syncDefaultCodeFromControls();
        this.persistProject();
    }

    duplicateArrangementSection(sectionId) {
        const index = this.arrangement.findIndex((section) => section.id === sectionId);
        if (index === -1) {
            return;
        }

        const section = this.arrangement[index];
        const duplicate = this.createArrangementSection(section.sceneId, `${section.name} Copy`, section.bars);
        const nextArrangement = [...this.arrangement];
        nextArrangement.splice(index + 1, 0, duplicate);
        this.arrangement = nextArrangement;
        this.renderArrangementTimeline();
        this.renderArrangementEditor();
        this.refreshTimelineMetrics();
        this.syncDefaultCodeFromControls();
        this.persistProject();
        this.showNotification('Section duplicated in the arrangement.', 'success');
    }

    addArrangementSection() {
        const fallbackScene = this.scenePresets[this.activeScene] ? this.activeScene : 'main';
        const label = this.scenePresets[fallbackScene]?.label || 'Section';
        this.arrangement = [
            ...this.arrangement,
            this.createArrangementSection(fallbackScene, `${label} ${this.arrangement.length + 1}`, 8)
        ];
        this.renderArrangementTimeline();
        this.renderArrangementEditor();
        this.refreshTimelineMetrics();
        this.syncDefaultCodeFromControls();
        this.persistProject();
        this.showNotification('Section added to the arrangement.', 'success');
    }

    removeArrangementSection(sectionId) {
        if (this.arrangement.length <= 1) {
            this.showNotification('Keep at least one section in the arrangement.', 'warning');
            return;
        }

        this.arrangement = this.arrangement.filter((section) => section.id !== sectionId);
        this.renderArrangementTimeline();
        this.renderArrangementEditor();
        this.refreshTimelineMetrics();
        this.syncDefaultCodeFromControls();
        this.persistProject();
        this.showNotification('Section removed from the arrangement.', 'info');
    }

    resetArrangement() {
        this.arrangement = this.createDefaultArrangement();
        this.renderArrangementTimeline();
        this.renderArrangementEditor();
        this.refreshTimelineMetrics();
        this.syncDefaultCodeFromControls();
        this.persistProject();
        this.showNotification('Default arrangement restored.', 'success');
    }

    renderExampleLibrary() {
        if (!this.dom.exampleLibraryList) {
            return;
        }

        this.dom.exampleLibraryList.innerHTML = '';

        this.exampleLibrary.forEach((example) => {
            const card = document.createElement('article');
            card.className = 'example-card';
            card.innerHTML = `
                <div class="example-card__header">
                    <div>
                        <h4>${example.name}</h4>
                        <p>${example.description}</p>
                    </div>
                    <div class="example-card__actions">
                        <button class="btn btn--secondary btn--sm example-use" type="button">Load Starter</button>
                        <button class="btn btn--outline btn--sm example-copy" type="button">Copy Code</button>
                    </div>
                </div>
                <pre class="example-code">${example.code.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>
            `;

            card.querySelector('.example-use').addEventListener('click', () => this.useExampleCode(example));
            card.querySelector('.example-copy').addEventListener('click', () => {
                this.copyText(example.code)
                    .then(() => this.showNotification(`${example.name} copied.`, 'success'))
                    .catch((error) => this.showNotification(`Could not copy starter code: ${error.message}`, 'error'));
            });

            this.dom.exampleLibraryList.appendChild(card);
        });
    }

    useExampleCode(example) {
        this.userHasCustomCode = true;
        this.dom.codeTextarea.value = example.code;

        if (!this.codeEditorVisible) {
            this.setWorkspaceLayout('split');
        } else {
            this.revealWorkspaceSurface();
            this.renderInterfaceShell();
        }

        this.persistProject();
        this.renderStrudelStatus(`${example.name} loaded into the workspace code panel. Press Update to evaluate it there while the main transport stays on the studio engine.`, 'info');
        this.showNotification(`${example.name} loaded into the workspace code panel.`, 'success');
    }

    async copyText(text) {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
            return;
        }

        const textArea = document.createElement('textarea');
        textArea.value = text;
        textArea.setAttribute('readonly', 'readonly');
        textArea.style.position = 'absolute';
        textArea.style.left = '-9999px';
        document.body.appendChild(textArea);
        textArea.select();
        document.execCommand('copy');
        document.body.removeChild(textArea);
    }

    serializeProject() {
        return {
            version: 5,
            projectMeta: {
                ...this.projectMeta,
                updatedAt: new Date().toISOString()
            },
            activeScene: this.activeScene,
            interfaceMode: this.interfaceMode,
            advancedTab: this.advancedTab,
            consoleDrawerTab: this.consoleDrawerTab,
            workspaceLayout: this.workspaceLayout,
            assistantVisible: this.assistantVisible,
            recordingOptions: {
                ...this.recordingOptions
            },
            arrangement: this.arrangement,
            projectPatterns: this.projectPatterns.map((pattern) => ({
                ...pattern,
                globalEffects: {
                    ...pattern.globalEffects
                },
                trackStates: this.cloneTrackStates(pattern.trackStates),
                sequenceConfig: this.cloneSequenceConfig(pattern.sequenceConfig),
                sampleSettings: this.cloneSampleSettings(pattern.sampleSettings)
            })),
            globalEffects: this.globalEffects,
            trackStates: this.trackStates,
            sequenceConfig: {
                kickSteps: [...this.sequenceConfig.kickSteps],
                snareSteps: [...this.sequenceConfig.snareSteps],
                hatSteps: [...this.sequenceConfig.hatSteps],
                vocalSteps: [...this.sequenceConfig.vocalSteps],
                fxSteps: [...this.sequenceConfig.fxSteps],
                textureSteps: [...this.sequenceConfig.textureSteps],
                percSteps: [...this.sequenceConfig.percSteps]
            },
            sampleSettings: {
                vocal: this.serializeSampleLaneSettings('vocal'),
                fx: this.serializeSampleLaneSettings('fx'),
                texture: this.serializeSampleLaneSettings('texture'),
                perc: this.serializeSampleLaneSettings('perc')
            },
            assistantMessages: this.normalizeAssistantMessages(this.assistantMessages),
            assistantPromptDraft: this.dom.assistantPromptInput.value,
            customCode: this.dom.codeTextarea.value,
            userHasCustomCode: this.userHasCustomCode
        };
    }

    serializeSampleLaneSettings(laneId) {
        const lane = this.sampleState[laneId];
        return {
            fileName: lane.fileName,
            mimeType: lane.mimeType,
            start: lane.start,
            end: lane.end,
            rate: lane.rate,
            reverse: lane.reverse
        };
    }

    normalizeTrackStates(trackStates = {}) {
        return Object.fromEntries(
            Object.entries(this.createDefaultTrackStates()).map(([trackId, defaults]) => ([
                trackId,
                {
                    ...defaults,
                    ...(trackStates[trackId] || {})
                }
            ]))
        );
    }

    applyProject(project) {
        if (project.projectMeta) {
            this.projectMeta = {
                ...this.projectMeta,
                ...project.projectMeta
            };
        }

        if (typeof project.activeScene === 'string' && (this.scenePresets[project.activeScene] || project.activeScene === 'custom')) {
            this.activeScene = project.activeScene;
        }

        if (project.arrangement) {
            this.arrangement = this.normalizeArrangement(project.arrangement);
        }

        if (Array.isArray(project.projectPatterns)) {
            this.projectPatterns = this.normalizeProjectPatterns(project.projectPatterns);
        } else {
            this.projectPatterns = [];
        }

        if (project.globalEffects) {
            this.globalEffects = {
                ...this.globalEffects,
                ...project.globalEffects
            };
        }

        if (project.recordingOptions) {
            this.recordingOptions = {
                ...this.recordingOptions,
                ...project.recordingOptions
            };
        }

        if (project.trackStates) {
            this.trackStates = this.normalizeTrackStates(project.trackStates);
        }

        const sequenceKeys = ['kickSteps', 'snareSteps', 'hatSteps', 'vocalSteps', 'fxSteps', 'textureSteps', 'percSteps'];
        sequenceKeys.forEach((key) => {
            if (Array.isArray(project.sequenceConfig?.[key])) {
                this.sequenceConfig[key] = this.parseVocalSteps(project.sequenceConfig[key].join(','));
            }
        });

        ['vocal', 'fx', 'texture', 'perc'].forEach((laneId) => {
            if (project.sampleSettings?.[laneId]) {
                this.sampleState[laneId] = {
                    ...this.createEmptySampleLaneState(),
                    ...this.sampleState[laneId],
                    ...project.sampleSettings[laneId],
                    buffer: null,
                    reverseBuffer: null
                };
            }
        });

        if (typeof project.workspaceLayout === 'string') {
            this.workspaceLayout = project.workspaceLayout;
        }

        if (typeof project.interfaceMode === 'string') {
            this.interfaceMode = project.interfaceMode === 'advanced' ? 'advanced' : 'simple';
        }

        if (typeof project.advancedTab === 'string') {
            this.advancedTab = ['arrange', 'sound', 'samples', 'code', 'projects'].includes(project.advancedTab)
                ? project.advancedTab
                : this.advancedTab;
        }

        if (typeof project.consoleDrawerTab === 'string') {
            this.consoleDrawerTab = ['workspace', 'projects', 'factory', 'system'].includes(project.consoleDrawerTab)
                ? project.consoleDrawerTab
                : this.consoleDrawerTab;
        }

        if (typeof project.assistantVisible === 'boolean') {
            this.assistantVisible = project.assistantVisible;
        }

        if (Array.isArray(project.assistantMessages)) {
            this.assistantMessages = this.normalizeAssistantMessages(project.assistantMessages);
        } else {
            this.assistantMessages = [];
        }

        if (typeof project.assistantPromptDraft === 'string') {
            this.dom.assistantPromptInput.value = project.assistantPromptDraft;
        } else {
            this.dom.assistantPromptInput.value = '';
        }

        if (typeof project.customCode === 'string') {
            this.dom.codeTextarea.value = project.customCode;
        }

        this.userHasCustomCode = Boolean(project.userHasCustomCode);
        this.defaultCode = this.buildDefaultCode();
        if (!this.userHasCustomCode) {
            this.dom.codeTextarea.value = this.defaultCode;
        }

        this.syncDomFromState();
        this.renderWorkspaceState();
        this.renderInterfaceShell();
        this.updateVolumeDisplays();
        this.updateEffectDisplays();
        this.updateSampleStatus();
        this.updateFxStatus();
        this.updateTextureStatus();
        this.updatePercStatus();
        this.engine.syncMix();
    }

    loadSavedProject() {
        try {
            const raw = localStorage.getItem(this.projectStorageKey) || localStorage.getItem(this.legacyProjectStorageKey);
            if (!raw) {
                return;
            }

            const parsed = JSON.parse(raw);
            this.applyProject(parsed);
        } catch (error) {
            console.warn('Could not load saved project state:', error);
        }
    }

    persistProject() {
        this.projectMeta.updatedAt = new Date().toISOString();
        this.projectPersistDirty = true;
        this.renderProjectMeta();

        if (this.projectPersistTimer) {
            clearTimeout(this.projectPersistTimer);
        }

        this.projectPersistTimer = window.setTimeout(() => {
            this.flushProjectPersistence();
        }, this.projectPersistDelayMs);
    }

    flushProjectPersistence() {
        if (this.projectPersistTimer) {
            clearTimeout(this.projectPersistTimer);
            this.projectPersistTimer = null;
        }

        if (!this.projectPersistDirty) {
            return;
        }

        try {
            localStorage.setItem(this.projectStorageKey, JSON.stringify(this.serializeProject()));
            this.projectPersistDirty = false;
            this.renderExportPanel();
        } catch (error) {
            console.warn('Could not persist project state:', error);
        }
    }

    async decodeSampleBlobForLane(laneId) {
        await this.engine.ensureAudioContext();
        const lane = this.sampleState[laneId];
        if (!lane?.blob) {
            return;
        }

        const arrayBuffer = await lane.blob.arrayBuffer();
        const decoded = await this.engine.audioContext.decodeAudioData(arrayBuffer.slice(0));
        lane.buffer = decoded;
        lane.reverseBuffer = this.createReverseBuffer(decoded);
    }

    createReverseBuffer(buffer) {
        const reversed = this.engine.audioContext.createBuffer(buffer.numberOfChannels, buffer.length, buffer.sampleRate);

        for (let channelIndex = 0; channelIndex < buffer.numberOfChannels; channelIndex += 1) {
            const sourceData = buffer.getChannelData(channelIndex);
            const destinationData = reversed.getChannelData(channelIndex);

            for (let index = 0; index < sourceData.length; index += 1) {
                destinationData[index] = sourceData[sourceData.length - 1 - index];
            }
        }

        return reversed;
    }

    async ensureSampleLaneReady(laneId) {
        const lane = this.sampleState[laneId];
        if (lane?.blob && !lane.buffer) {
            await this.decodeSampleBlobForLane(laneId);
        }
    }

    async ensureImportedLanesReady() {
        const laneIds = ['vocal', 'fx', 'texture', 'perc'];
        for (const laneId of laneIds) {
            // eslint-disable-next-line no-await-in-loop
            await this.ensureSampleLaneReady(laneId);
        }
    }

    async handleSampleFile(laneId, file) {
        const existingReverse = this.sampleState[laneId]?.reverse ?? false;
        this.sampleState[laneId] = {
            ...this.createEmptySampleLaneState(),
            fileName: file.name,
            mimeType: file.type || 'audio/*',
            blob: file,
            reverse: existingReverse
        };

        await this.decodeSampleBlobForLane(laneId);
        this.syncDomFromState();
        this.updateEffectDisplays();
        this.updateLaneStatus(laneId);
        this.markSceneCustom();
        this.syncDefaultCodeFromControls();
        this.persistProject();
        this.showNotification(`Loaded ${this.getLaneLabel(laneId)} sample: ${file.name}`, 'success');
    }

    async handleVocalSampleFile(file) {
        return this.handleSampleFile('vocal', file);
    }

    async handleFxSampleFile(file) {
        return this.handleSampleFile('fx', file);
    }

    async handleTextureSampleFile(file) {
        return this.handleSampleFile('texture', file);
    }

    async handlePercSampleFile(file) {
        return this.handleSampleFile('perc', file);
    }

    clearSampleLane(laneId) {
        this.sampleState[laneId] = this.createEmptySampleLaneState();
        this.syncDomFromState();
        this.updateEffectDisplays();
        this.updateLaneStatus(laneId);
        this.markSceneCustom();
        this.syncDefaultCodeFromControls();
        this.persistProject();
        this.showNotification(`${this.getLaneLabel(laneId)} sample cleared. The built-in factory layer is active again.`, 'info');
    }

    clearVocalSample() {
        this.clearSampleLane('vocal');
    }

    clearFxSample() {
        this.clearSampleLane('fx');
    }

    clearTextureSample() {
        this.clearSampleLane('texture');
    }

    clearPercSample() {
        this.clearSampleLane('perc');
    }

    async auditionSampleLane(laneId) {
        await this.engine.ensureAudioContext();
        await this.ensureSampleLaneReady(laneId);
        const time = this.engine.audioContext.currentTime + 0.03;

        if (laneId === 'vocal') {
            this.engine.scheduleVocalPulse(time);
        } else if (laneId === 'fx') {
            this.engine.scheduleFxPulse(time);
        } else if (laneId === 'texture') {
            this.engine.scheduleTexturePulse(time);
        } else if (laneId === 'perc') {
            this.engine.schedulePercPulse(time);
        }

        this.renderStrudelStatus(`Playing a quick ${this.getLaneLabel(laneId).toLowerCase()} preview from the current slice and rate settings.`, 'ready');
    }

    async auditionVocalSample() {
        return this.auditionSampleLane('vocal');
    }

    async auditionFxSample() {
        return this.auditionSampleLane('fx');
    }

    async auditionTextureSample() {
        return this.auditionSampleLane('texture');
    }

    async auditionPercSample() {
        return this.auditionSampleLane('perc');
    }

    toggleRhythmStep(laneId, step) {
        const key = `${laneId}Steps`;
        const stepSet = new Set(this.sequenceConfig[key]);

        if (stepSet.has(step)) {
            stepSet.delete(step);
        } else {
            stepSet.add(step);
        }

        this.sequenceConfig[key] = Array.from(stepSet).sort((left, right) => left - right);
        this.renderRhythmStepGrid();
        this.updateRhythmSummaries();
        this.markSceneCustom();
        this.syncDefaultCodeFromControls();
        this.persistProject();
    }

    toggleVocalStep(step) {
        const stepSet = new Set(this.sequenceConfig.vocalSteps);

        if (stepSet.has(step)) {
            stepSet.delete(step);
        } else {
            stepSet.add(step);
        }

        this.sequenceConfig.vocalSteps = Array.from(stepSet).sort((left, right) => left - right);
        this.dom.vocalStepInput.value = this.sequenceConfig.vocalSteps.join(',');
        this.renderVocalStepGrid();
        this.updateSampleStatus();
        this.markSceneCustom();
        this.syncDefaultCodeFromControls();
        this.persistProject();
    }

    toggleFxStep(step) {
        const stepSet = new Set(this.sequenceConfig.fxSteps);

        if (stepSet.has(step)) {
            stepSet.delete(step);
        } else {
            stepSet.add(step);
        }

        this.sequenceConfig.fxSteps = Array.from(stepSet).sort((left, right) => left - right);
        this.dom.fxStepInput.value = this.sequenceConfig.fxSteps.join(',');
        this.renderFxStepGrid();
        this.updateFxStatus();
        this.markSceneCustom();
        this.syncDefaultCodeFromControls();
        this.persistProject();
    }

    toggleTextureStep(step) {
        const stepSet = new Set(this.sequenceConfig.textureSteps);

        if (stepSet.has(step)) {
            stepSet.delete(step);
        } else {
            stepSet.add(step);
        }

        this.sequenceConfig.textureSteps = Array.from(stepSet).sort((left, right) => left - right);
        this.dom.textureStepInput.value = this.sequenceConfig.textureSteps.join(',');
        this.renderTextureStepGrid();
        this.updateTextureStatus();
        this.markSceneCustom();
        this.syncDefaultCodeFromControls();
        this.persistProject();
    }

    togglePercStep(step) {
        const stepSet = new Set(this.sequenceConfig.percSteps);

        if (stepSet.has(step)) {
            stepSet.delete(step);
        } else {
            stepSet.add(step);
        }

        this.sequenceConfig.percSteps = Array.from(stepSet).sort((left, right) => left - right);
        this.dom.percStepInput.value = this.sequenceConfig.percSteps.join(',');
        this.renderPercStepGrid();
        this.updatePercStatus();
        this.markSceneCustom();
        this.syncDefaultCodeFromControls();
        this.persistProject();
    }

    normalizeStepSequence(steps) {
        return Array.from(new Set(steps.map((step) => Number.parseInt(step, 10))))
            .filter((step) => Number.isFinite(step) && step >= 1 && step <= 16)
            .sort((left, right) => left - right);
    }

    pickRandomSteps(pool, count) {
        const workingPool = [...pool];
        const chosen = [];

        while (workingPool.length && chosen.length < count) {
            const index = Math.floor(Math.random() * workingPool.length);
            const [step] = workingPool.splice(index, 1);
            chosen.push(step);
        }

        return chosen.sort((left, right) => left - right);
    }

    createSurpriseRhythmPattern() {
        const kickPool = [1, 3, 4, 5, 7, 9, 11, 12, 13, 15];
        const snarePool = [5, 8, 10, 13, 16];
        const hatPool = Array.from({ length: 16 }, (_, index) => index + 1);

        const kickCount = 4 + Math.floor(Math.random() * 2);
        const snareCount = 2 + Math.floor(Math.random() * 2);
        const hatCount = 8 + Math.floor(Math.random() * 5);

        return {
            kickSteps: this.normalizeStepSequence([1, ...this.pickRandomSteps(kickPool, kickCount)]),
            snareSteps: this.normalizeStepSequence([5, 13, ...this.pickRandomSteps(snarePool, snareCount)]),
            hatSteps: this.pickRandomSteps(hatPool, hatCount)
        };
    }

    applyRhythmState(pattern, statusMessage, noticeMessage) {
        this.sequenceConfig.kickSteps = this.normalizeStepSequence(pattern.kickSteps);
        this.sequenceConfig.snareSteps = this.normalizeStepSequence(pattern.snareSteps);
        this.sequenceConfig.hatSteps = this.normalizeStepSequence(pattern.hatSteps);
        this.renderRhythmStepGrid();
        this.updateRhythmSummaries();
        this.markSceneCustom();
        this.syncDefaultCodeFromControls();
        this.persistProject();
        this.renderStrudelStatus(statusMessage, 'ready');
        if (noticeMessage) {
            this.showNotification(noticeMessage, 'success');
        }
    }

    applyRhythmAction(actionId) {
        const actions = {
            tighten: {
                pattern: {
                    kickSteps: [1, 5, 9, 13],
                    snareSteps: [5, 13],
                    hatSteps: [1, 3, 5, 7, 9, 11, 13, 15]
                },
                status: 'Beat tightened into a dependable floor-driving groove. Keep shaping from there.',
                notice: 'Beat tightened.'
            },
            'hat-drive': {
                pattern: {
                    kickSteps: [...this.sequenceConfig.kickSteps],
                    snareSteps: [...this.sequenceConfig.snareSteps],
                    hatSteps: Array.from({ length: 16 }, (_, index) => index + 1)
                },
                status: 'Hat motion pushed to full sixteenth-note drive.',
                notice: 'Full hat drive loaded.'
            },
            'break-shuffle': {
                pattern: {
                    kickSteps: [1, 4, 7, 11, 13],
                    snareSteps: [5, 13],
                    hatSteps: [1, 3, 6, 8, 10, 12, 15, 16]
                },
                status: 'Break shuffle loaded for a more broken rave pulse.',
                notice: 'Break shuffle loaded.'
            },
            surprise: {
                pattern: this.createSurpriseRhythmPattern(),
                status: 'A fresh surprise groove landed in the beat designer.',
                notice: 'Surprise groove generated.'
            },
            clear: {
                pattern: {
                    kickSteps: [],
                    snareSteps: [],
                    hatSteps: []
                },
                status: 'Beat cleared. Build it back up from silence.',
                notice: 'Beat cleared.'
            }
        };

        const action = actions[actionId];
        if (!action) {
            return;
        }

        this.applyRhythmState(action.pattern, action.status, action.notice);
    }

    getSequenceConfigKey(laneId) {
        const map = {
            kick: 'kickSteps',
            snare: 'snareSteps',
            hat: 'hatSteps',
            vocal: 'vocalSteps',
            fx: 'fxSteps',
            texture: 'textureSteps',
            perc: 'percSteps'
        };

        return map[laneId] || 'kickSteps';
    }

    getSequenceRenderMethod(laneId) {
        const map = {
            vocal: 'renderVocalStepGrid',
            fx: 'renderFxStepGrid',
            texture: 'renderTextureStepGrid',
            perc: 'renderPercStepGrid'
        };

        return map[laneId] || '';
    }

    rotateStepSequence(steps, amount) {
        return this.normalizeStepSequence(
            steps.map((step) => {
                const shifted = ((step - 1 + amount) % 16 + 16) % 16;
                return shifted + 1;
            })
        );
    }

    densifyStepSequence(steps) {
        return this.normalizeStepSequence(
            steps.flatMap((step) => [step, (((step - 1) + 1) % 16) + 1])
        );
    }

    thinStepSequence(steps) {
        return this.normalizeStepSequence(
            steps.filter((_, index) => index % 2 === 0)
        );
    }

    applySequencerAction(actionId) {
        const laneId = this.dom.sequenceTargetLane.value;
        const key = this.getSequenceConfigKey(laneId);
        const currentSteps = [...this.sequenceConfig[key]];
        let nextSteps = currentSteps;

        if (actionId === 'shift-left') {
            nextSteps = this.rotateStepSequence(currentSteps, -1);
        } else if (actionId === 'shift-right') {
            nextSteps = this.rotateStepSequence(currentSteps, 1);
        } else if (actionId === 'densify') {
            nextSteps = this.densifyStepSequence(currentSteps);
        } else if (actionId === 'thin') {
            nextSteps = this.thinStepSequence(currentSteps);
        } else if (actionId === 'clear') {
            nextSteps = [];
        }

        this.sequenceConfig[key] = nextSteps;
        if (laneId === 'kick' || laneId === 'snare' || laneId === 'hat') {
            this.renderRhythmStepGrid();
            this.updateRhythmSummaries();
        } else {
            this.dom[`${laneId}StepInput`].value = nextSteps.join(',');
            const renderMethod = this.getSequenceRenderMethod(laneId);
            if (renderMethod) {
                this[renderMethod]();
            }
            this.updateLaneStatus(laneId);
        }

        this.markSceneCustom();
        this.syncDefaultCodeFromControls();
        this.persistProject();
        this.renderStrudelStatus(`${this.getLaneLabel(laneId)} lane updated with ${actionId.replace('-', ' ')}.`, 'ready');
    }

    applyRhythmPreset(presetId) {
        const preset = this.rhythmPresets[presetId];
        if (!preset) {
            return;
        }

        this.applyRhythmState({
            kickSteps: preset.kickSteps,
            snareSteps: preset.snareSteps,
            hatSteps: preset.hatSteps
        }, `${preset.label} rhythm loaded. Keep clicking steps to shape it into your own groove.`, `${preset.label} rhythm loaded.`);
    }

    applyScenePreset(sceneId) {
        const scene = this.scenePresets[sceneId];
        if (!scene) {
            return;
        }

        this.activeScene = sceneId;
        this.globalEffects = {
            ...this.globalEffects,
            ...scene.globalEffects
        };

        Object.entries(scene.trackStates).forEach(([trackId, trackState]) => {
            this.trackStates[trackId] = {
                ...this.trackStates[trackId],
                ...trackState
            };
        });

        if (scene.sequenceConfig?.kickSteps) {
            this.sequenceConfig.kickSteps = [...scene.sequenceConfig.kickSteps];
        }

        if (scene.sequenceConfig?.snareSteps) {
            this.sequenceConfig.snareSteps = [...scene.sequenceConfig.snareSteps];
        }

        if (scene.sequenceConfig?.hatSteps) {
            this.sequenceConfig.hatSteps = [...scene.sequenceConfig.hatSteps];
        }

        if (scene.sequenceConfig?.vocalSteps) {
            this.sequenceConfig.vocalSteps = [...scene.sequenceConfig.vocalSteps];
        }

        if (scene.sequenceConfig?.fxSteps) {
            this.sequenceConfig.fxSteps = [...scene.sequenceConfig.fxSteps];
        }

        if (scene.sequenceConfig?.textureSteps) {
            this.sequenceConfig.textureSteps = [...scene.sequenceConfig.textureSteps];
        }

        if (scene.sequenceConfig?.percSteps) {
            this.sequenceConfig.percSteps = [...scene.sequenceConfig.percSteps];
        }

        this.syncDomFromState();
        this.updateVolumeDisplays();
        this.updateEffectDisplays();
        this.updateSampleStatus();
        this.updateFxStatus();
        this.updateTextureStatus();
        this.updatePercStatus();
        this.engine.syncMix();
        this.syncDefaultCodeFromControls();
        this.persistProject();
        this.renderStrudelStatus(`${scene.label} scene loaded. ${scene.description}`, 'ready');
        this.showNotification(`${scene.label} scene loaded.`, 'success');
    }

    async saveProjectToBrowser() {
        this.persistProject();
        this.flushProjectPersistence();
        const record = this.buildProjectRecord();
        await this.saveProjectRecord(record);
        await this.loadProjectLibrary();
        this.showNotification(`Saved snapshot "${this.projectMeta.name}".`, 'success');
    }

    async exportProject() {
        const project = this.serializeProject();
        const sampleAssets = {};

        for (const laneId of ['vocal', 'fx', 'texture', 'perc']) {
            if (this.sampleState[laneId].blob) {
                // eslint-disable-next-line no-await-in-loop
                sampleAssets[laneId] = await this.blobToDataUrl(this.sampleState[laneId].blob);
            }
        }

        const exportPayload = {
            ...project,
            sampleAssets
        };

        const blob = new Blob([JSON.stringify(exportPayload, null, 2)], { type: 'application/json;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `${this.projectMeta.name.replace(/[^\w-]+/g, '-').toLowerCase() || 'strudel-project'}.json`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
        this.showNotification('Project exported.', 'success');
    }

    async importProject(file) {
        const text = await file.text();
        const project = JSON.parse(text);
        this.applyProject(project);
        if (project.sampleAssets) {
            for (const laneId of ['vocal', 'fx', 'texture', 'perc']) {
                const dataUrl = project.sampleAssets[laneId];
                if (!dataUrl) {
                    continue;
                }

                // eslint-disable-next-line no-await-in-loop
                const blob = await this.dataUrlToBlob(dataUrl);
                this.sampleState[laneId].blob = blob;
                this.sampleState[laneId].buffer = null;
                this.sampleState[laneId].reverseBuffer = null;
            }
            this.updateSampleStatus();
            this.updateFxStatus();
            this.updateTextureStatus();
            this.updatePercStatus();
        }
        this.persistProject();
        this.showNotification('Project imported.', 'success');
        this.renderStrudelStatus('Project imported. Embedded sample lanes were restored if they were included in the file.', 'info');
    }

    setupEventListeners() {
        window.addEventListener('pagehide', () => this.flushProjectPersistence());
        window.addEventListener('beforeunload', () => this.flushProjectPersistence());
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                this.flushProjectPersistence();
            }
        });
        window.addEventListener('pointermove', (event) => this.handleTimelinePointerMove(event));
        window.addEventListener('pointerup', () => this.finishTimelineInteraction());
        window.addEventListener('pointercancel', () => this.finishTimelineInteraction());
        this.dom.simpleViewBtn.addEventListener('click', () => this.setInterfaceMode('simple'));
        this.dom.advancedViewBtn.addEventListener('click', () => this.setInterfaceMode('advanced'));
        this.dom.drawerTabButtons.forEach((button) => {
            button.addEventListener('click', () => this.setConsoleDrawerTab(button.dataset.drawerTab));
        });
        this.dom.advancedTabButtons.forEach((button) => {
            button.addEventListener('click', () => this.setAdvancedTab(button.dataset.advancedTab));
        });
        this.dom.structureTemplateButtons.forEach((button) => {
            button.addEventListener('click', () => this.applyStructureTemplate(button.dataset.structureTemplate));
        });

        this.dom.installAppBtn?.addEventListener('click', () => {
            this.promptInstall().catch((error) => {
                this.showNotification(`Install prompt failed: ${error.message}`, 'warning');
            });
        });

        this.dom.playStopBtn.addEventListener('click', () => this.togglePlayStop());
        this.dom.recordBtn.addEventListener('click', () => this.toggleRecording());
        this.dom.audioCheckBtn.addEventListener('click', () => {
            this.runAudioCheck().catch((error) => {
                console.error('Audio check failed:', error);
                this.showNotification(`Audio check failed: ${error.message}`, 'warning');
            });
        });
        this.dom.takeNameInput.addEventListener('input', (event) => {
            this.recordingOptions.takeLabel = event.target.value || 'untitled-session';
            this.persistProject();
        });
        this.dom.autoStopRecordInput.addEventListener('change', (event) => {
            this.recordingOptions.autoStopAtEnd = event.target.checked;
            this.persistProject();
        });
        this.dom.auditionVocalBtn.addEventListener('click', () => {
            this.auditionVocalSample().catch((error) => {
                console.error('Sample audition failed:', error);
                this.showNotification(`Sample audition failed: ${error.message}`, 'error');
            });
        });
        this.dom.clearVocalBtn.addEventListener('click', () => this.clearVocalSample());
        this.dom.auditionFxBtn.addEventListener('click', () => {
            this.auditionFxSample().catch((error) => {
                console.error('FX audition failed:', error);
                this.showNotification(`FX audition failed: ${error.message}`, 'error');
            });
        });
        this.dom.clearFxBtn.addEventListener('click', () => this.clearFxSample());
        this.dom.auditionTextureBtn.addEventListener('click', () => {
            this.auditionTextureSample().catch((error) => {
                console.error('Texture audition failed:', error);
                this.showNotification(`Texture audition failed: ${error.message}`, 'error');
            });
        });
        this.dom.clearTextureBtn.addEventListener('click', () => this.clearTextureSample());
        this.dom.auditionPercBtn.addEventListener('click', () => {
            this.auditionPercSample().catch((error) => {
                console.error('Perc audition failed:', error);
                this.showNotification(`Perc audition failed: ${error.message}`, 'error');
            });
        });
        this.dom.clearPercBtn.addEventListener('click', () => this.clearPercSample());

        this.dom.sceneButtons.forEach((button) => {
            button.addEventListener('click', () => this.applyScenePreset(button.dataset.scene));
        });

        this.dom.rhythmPresetButtons.forEach((button) => {
            button.addEventListener('click', () => this.applyRhythmPreset(button.dataset.rhythmPreset));
        });
        this.dom.rhythmActionButtons.forEach((button) => {
            button.addEventListener('click', () => this.applyRhythmAction(button.dataset.rhythmAction));
        });
        this.dom.sequencerActionButtons.forEach((button) => {
            button.addEventListener('click', () => this.applySequencerAction(button.dataset.sequenceAction));
        });

        this.dom.addSectionBtn?.addEventListener('click', () => this.addArrangementSection());
        this.dom.resetArrangementBtn?.addEventListener('click', () => this.resetArrangement());
        this.dom.capturePatternBtn?.addEventListener('click', () => this.captureCurrentPattern());

        this.dom.masterVolume.addEventListener('input', (event) => {
            this.globalEffects.masterVolume = event.target.value / 100;
            this.updateVolumeDisplay(event.target.nextElementSibling, event.target.value);
            this.engine.syncMix();
            this.markSceneCustom();
            this.syncDefaultCodeFromControls();
            this.persistProject();
        });

        this.dom.tempoSlider.addEventListener('input', (event) => {
            this.globalEffects.tempo = parseInt(event.target.value, 10);
            this.updateTempoDisplay(event.target.nextElementSibling, event.target.value);
            this.dom.projectTempoInput.value = this.globalEffects.tempo;
            this.refreshTimelineMetrics();
            this.renderArrangementTimeline();
            this.markSceneCustom();
            this.syncDefaultCodeFromControls();
            this.persistProject();
        });

        document.querySelectorAll('.track-volume-slider').forEach((slider) => {
            slider.addEventListener('input', (event) => {
                const trackId = event.target.dataset.track;
                this.trackStates[trackId].volume = event.target.value / 100;
                this.updateVolumeDisplay(event.target.nextElementSibling, event.target.value);
                this.engine.syncMix();
                this.markSceneCustom();
                this.syncDefaultCodeFromControls();
                this.persistProject();
            });
        });

        document.querySelectorAll('.track-pan-slider').forEach((slider) => {
            slider.addEventListener('input', (event) => {
                const trackId = event.target.dataset.track;
                this.trackStates[trackId].pan = event.target.value / 100;
                this.updatePanDisplay(event.target.nextElementSibling, event.target.value);
                this.engine.syncMix();
                this.markSceneCustom();
                this.persistProject();
            });
        });

        [this.dom.reverbSlider, this.dom.delaySlider, this.dom.filterSlider].forEach((slider) => {
            slider.addEventListener('input', (event) => {
                const keyMap = {
                    reverbSlider: 'reverb',
                    delaySlider: 'delay',
                    filterSlider: 'filter'
                };
                this.globalEffects[keyMap[event.target.id]] = event.target.value / 100;
                this.updateEffectDisplay(event.target.nextElementSibling, event.target.value);
                this.engine.syncMix();
                this.markSceneCustom();
                this.syncDefaultCodeFromControls();
                this.persistProject();
            });
        });

        document.querySelectorAll('.mute-btn').forEach((button) => {
            button.addEventListener('click', (event) => {
                const trackControl = event.target.closest('.track-control');
                const trackId = trackControl.dataset.track;
                this.toggleMute(trackId, button, trackControl);
            });
        });

        document.querySelectorAll('.solo-btn').forEach((button) => {
            button.addEventListener('click', (event) => {
                const trackControl = event.target.closest('.track-control');
                const trackId = trackControl.dataset.track;
                this.toggleSolo(trackId, button, trackControl);
            });
        });

        this.dom.vocalSampleInput.addEventListener('change', (event) => {
            const [file] = event.target.files || [];
            if (!file) {
                return;
            }

            this.handleVocalSampleFile(file).catch((error) => {
                console.error('Sample import failed:', error);
                this.showNotification(`Sample import failed: ${error.message}`, 'error');
            });
        });

        this.dom.fxSampleInput.addEventListener('change', (event) => {
            const [file] = event.target.files || [];
            if (!file) {
                return;
            }

            this.handleFxSampleFile(file).catch((error) => {
                console.error('FX import failed:', error);
                this.showNotification(`FX import failed: ${error.message}`, 'error');
            });
        });
        this.dom.textureSampleInput.addEventListener('change', (event) => {
            const [file] = event.target.files || [];
            if (!file) {
                return;
            }

            this.handleTextureSampleFile(file).catch((error) => {
                console.error('Texture import failed:', error);
                this.showNotification(`Texture import failed: ${error.message}`, 'error');
            });
        });

        this.dom.percSampleInput.addEventListener('change', (event) => {
            const [file] = event.target.files || [];
            if (!file) {
                return;
            }

            this.handlePercSampleFile(file).catch((error) => {
                console.error('Perc import failed:', error);
                this.showNotification(`Perc import failed: ${error.message}`, 'error');
            });
        });

        this.dom.vocalStepInput.addEventListener('change', (event) => {
            const steps = this.parseVocalSteps(event.target.value);
            this.sequenceConfig.vocalSteps = steps.length ? steps : [8, 16];
            event.target.value = this.sequenceConfig.vocalSteps.join(',');
            this.renderVocalStepGrid();
            this.updateSampleStatus();
            this.markSceneCustom();
            this.syncDefaultCodeFromControls();
            this.persistProject();
        });

        this.dom.fxStepInput.addEventListener('change', (event) => {
            const steps = this.parseVocalSteps(event.target.value);
            this.sequenceConfig.fxSteps = steps;
            event.target.value = this.sequenceConfig.fxSteps.join(',');
            this.renderFxStepGrid();
            this.updateFxStatus();
            this.markSceneCustom();
            this.syncDefaultCodeFromControls();
            this.persistProject();
        });

        this.dom.textureStepInput.addEventListener('change', (event) => {
            const steps = this.parseVocalSteps(event.target.value);
            this.sequenceConfig.textureSteps = steps;
            event.target.value = this.sequenceConfig.textureSteps.join(',');
            this.renderTextureStepGrid();
            this.updateTextureStatus();
            this.markSceneCustom();
            this.syncDefaultCodeFromControls();
            this.persistProject();
        });

        this.dom.percStepInput.addEventListener('change', (event) => {
            const steps = this.parseVocalSteps(event.target.value);
            this.sequenceConfig.percSteps = steps;
            event.target.value = this.sequenceConfig.percSteps.join(',');
            this.renderPercStepGrid();
            this.updatePercStatus();
            this.markSceneCustom();
            this.syncDefaultCodeFromControls();
            this.persistProject();
        });

        [
            ['vocalStartSlider', 'start'],
            ['vocalEndSlider', 'end'],
            ['vocalRateSlider', 'rate']
        ].forEach(([id, key]) => {
            this.dom[id].addEventListener('input', (event) => {
                const value = event.target.value / 100;
                if (key === 'start') {
                    this.sampleState.vocal.start = Math.min(value, this.sampleState.vocal.end - 0.05);
                    event.target.value = Math.round(this.sampleState.vocal.start * 100);
                } else if (key === 'end') {
                    this.sampleState.vocal.end = Math.max(value, this.sampleState.vocal.start + 0.05);
                    event.target.value = Math.round(this.sampleState.vocal.end * 100);
                } else {
                    this.sampleState.vocal.rate = value;
                }

                this.updateEffectDisplay(event.target.nextElementSibling, event.target.value);
                this.updateSampleStatus();
                this.markSceneCustom();
                this.syncDefaultCodeFromControls();
                this.persistProject();
            });
        });

        [
            ['fxStartSlider', 'start'],
            ['fxEndSlider', 'end'],
            ['fxRateSlider', 'rate']
        ].forEach(([id, key]) => {
            this.dom[id].addEventListener('input', (event) => {
                const value = event.target.value / 100;
                if (key === 'start') {
                    this.sampleState.fx.start = Math.min(value, this.sampleState.fx.end - 0.05);
                    event.target.value = Math.round(this.sampleState.fx.start * 100);
                } else if (key === 'end') {
                    this.sampleState.fx.end = Math.max(value, this.sampleState.fx.start + 0.05);
                    event.target.value = Math.round(this.sampleState.fx.end * 100);
                } else {
                    this.sampleState.fx.rate = value;
                }

                this.updateEffectDisplay(event.target.nextElementSibling, event.target.value);
                this.updateFxStatus();
                this.markSceneCustom();
                this.syncDefaultCodeFromControls();
                this.persistProject();
            });
        });

        [
            ['textureStartSlider', 'start', 'texture'],
            ['textureEndSlider', 'end', 'texture'],
            ['textureRateSlider', 'rate', 'texture'],
            ['percStartSlider', 'start', 'perc'],
            ['percEndSlider', 'end', 'perc'],
            ['percRateSlider', 'rate', 'perc']
        ].forEach(([id, key, laneId]) => {
            this.dom[id].addEventListener('input', (event) => {
                const lane = this.sampleState[laneId];
                const value = event.target.value / 100;
                if (key === 'start') {
                    lane.start = Math.min(value, lane.end - 0.05);
                    event.target.value = Math.round(lane.start * 100);
                } else if (key === 'end') {
                    lane.end = Math.max(value, lane.start + 0.05);
                    event.target.value = Math.round(lane.end * 100);
                } else {
                    lane.rate = value;
                }

                this.updateEffectDisplay(event.target.nextElementSibling, event.target.value);
                this.updateLaneStatus(laneId);
                this.markSceneCustom();
                this.syncDefaultCodeFromControls();
                this.persistProject();
            });
        });

        [
            ['vocalReverseToggle', 'vocal'],
            ['fxReverseToggle', 'fx'],
            ['textureReverseToggle', 'texture'],
            ['percReverseToggle', 'perc']
        ].forEach(([id, laneId]) => {
            this.dom[id].addEventListener('change', (event) => {
                this.sampleState[laneId].reverse = event.target.checked;
                this.updateLaneStatus(laneId);
                this.syncDefaultCodeFromControls();
                this.persistProject();
            });
        });

        this.dom.sampleBrowserSearch.addEventListener('input', () => this.renderSampleBrowser());
        this.dom.sampleBrowserTargetLane.addEventListener('change', () => this.renderSampleBrowser());

        this.dom.newProjectBtn.addEventListener('click', () => this.newProject());
        this.dom.duplicateProjectBtn.addEventListener('click', () => {
            this.duplicateProject().catch((error) => {
                console.error('Project duplicate failed:', error);
                this.showNotification(`Project duplicate failed: ${error.message}`, 'error');
            });
        });
        this.dom.projectNameInput.addEventListener('input', (event) => {
            this.projectMeta.name = event.target.value || 'Untitled Session';
            this.syncDefaultCodeFromControls();
            this.persistProject();
        });
        this.dom.projectKeyInput.addEventListener('input', (event) => {
            this.projectMeta.key = event.target.value || '';
            this.syncDefaultCodeFromControls();
            this.persistProject();
        });
        this.dom.projectTempoInput.addEventListener('input', (event) => {
            const nextTempo = Math.max(100, Math.min(160, parseInt(event.target.value || this.globalEffects.tempo, 10) || this.globalEffects.tempo));
            this.globalEffects.tempo = nextTempo;
            this.dom.tempoSlider.value = nextTempo;
            this.updateTempoDisplay(this.dom.tempoSlider.nextElementSibling, nextTempo);
            this.refreshTimelineMetrics();
            this.renderArrangementTimeline();
            this.markSceneCustom();
            this.syncDefaultCodeFromControls();
            this.persistProject();
        });
        this.dom.projectNotesInput.addEventListener('input', (event) => {
            this.projectMeta.notes = event.target.value;
            this.syncDefaultCodeFromControls();
            this.persistProject();
        });

        this.dom.toggleCodeBtn.addEventListener('click', () => this.toggleCodeEditor());
        this.dom.studioLayoutBtn.addEventListener('click', () => this.setWorkspaceLayout('studio'));
        this.dom.splitLayoutBtn.addEventListener('click', () => this.setWorkspaceLayout('split'));
        this.dom.codeLayoutBtn.addEventListener('click', () => this.setWorkspaceLayout('code'));
        this.dom.toggleAssistantBtn.addEventListener('click', () => this.toggleAssistantPanel());
        this.dom.updateCodeBtn.addEventListener('click', () => this.updateCode());
        this.dom.resetCodeBtn.addEventListener('click', () => this.resetCode());
        this.dom.exportCodeBtn.addEventListener('click', () => this.exportCode());
        this.dom.saveProjectBtn.addEventListener('click', () => {
            this.saveProjectToBrowser().catch((error) => {
                console.error('Project save failed:', error);
                this.showNotification(`Project save failed: ${error.message}`, 'error');
            });
        });
        this.dom.exportProjectBtn.addEventListener('click', () => {
            this.exportProject().catch((error) => {
                console.error('Project export failed:', error);
                this.showNotification(`Project export failed: ${error.message}`, 'error');
            });
        });
        this.dom.importProjectBtn.addEventListener('click', () => this.dom.importProjectInput.click());
        this.dom.importProjectInput.addEventListener('change', (event) => {
            const [file] = event.target.files || [];
            if (!file) {
                return;
            }

            this.importProject(file).catch((error) => {
                console.error('Project import failed:', error);
                this.showNotification(`Project import failed: ${error.message}`, 'error');
            });
            event.target.value = '';
        });
        this.dom.refreshExportJsonBtn.addEventListener('click', () => this.renderExportPanel());
        this.dom.copyProjectJsonBtn.addEventListener('click', () => {
            this.copyText(this.buildProjectJsonPreview())
                .then(() => this.showNotification('Session JSON copied.', 'success'))
                .catch((error) => this.showNotification(`Could not copy JSON: ${error.message}`, 'error'));
        });
        this.dom.downloadProjectJsonBtn.addEventListener('click', () => this.downloadProjectJson());
        this.dom.codeTextarea.addEventListener('input', () => {
            this.userHasCustomCode = true;
            this.queueExportPanelRefresh();
            this.persistProject();
        });
        this.dom.assistantEndpointInput.addEventListener('change', () => this.persistAssistantSettings());
        this.dom.assistantModelInput.addEventListener('change', () => this.persistAssistantSettings());
        this.dom.assistantSystemPrompt.addEventListener('change', () => this.persistAssistantSettings());
        this.dom.clearAssistantChatBtn.addEventListener('click', () => this.clearAssistantConversation());
        this.dom.detectAssistantBtn.addEventListener('click', () => {
            this.detectLocalAssistant().catch((error) => {
                console.error('Assistant detection failed:', error);
                this.setAssistantStatus(error.message);
                this.showNotification(error.message, 'warning');
            });
        });
        this.dom.testAssistantBtn.addEventListener('click', () => {
            this.testAssistantConnection().catch((error) => {
                console.error('Assistant connection test failed:', error);
                this.setAssistantStatus(error.message);
                this.showNotification(`Assistant test failed: ${error.message}`, 'warning');
            });
        });
        this.dom.assistantSendBtn.addEventListener('click', () => {
            this.sendAssistantPrompt().catch((error) => {
                console.error('Assistant request failed:', error);
                this.setAssistantStatus(error.message);
                this.showNotification(`Assistant request failed: ${error.message}`, 'error');
            });
        });
        this.dom.assistantPromptInput.addEventListener('keydown', (event) => {
            if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                event.preventDefault();
                this.sendAssistantPrompt().catch((error) => {
                    console.error('Assistant request failed:', error);
                    this.setAssistantStatus(error.message);
                    this.showNotification(`Assistant request failed: ${error.message}`, 'error');
                });
            }
        });
        this.dom.assistantPromptInput.addEventListener('input', () => this.persistProject());
        this.dom.assistantSuggestionButtons.forEach((button) => {
            button.addEventListener('click', () => {
                this.dom.assistantPromptInput.value = button.dataset.prompt;
                this.persistProject();
                this.sendAssistantPrompt().catch((error) => {
                    console.error('Assistant request failed:', error);
                    this.setAssistantStatus(error.message);
                    this.showNotification(`Assistant request failed: ${error.message}`, 'error');
                });
            });
        });
    }

    setupCodeEditor() {
        this.codeEditorVisible = this.workspaceLayout !== 'studio';
        this.renderWorkspaceState();
    }

    setWorkspaceLayout(mode) {
        const nextMode = ['studio', 'split', 'code'].includes(mode) ? mode : 'studio';
        this.workspaceLayout = nextMode;
        this.codeEditorVisible = nextMode !== 'studio';
        if (nextMode === 'studio') {
            this.assistantVisible = false;
        } else {
            this.revealWorkspaceSurface();
            if (nextMode === 'code') {
                this.assistantVisible = true;
            }
        }

        this.renderWorkspaceState();
        this.renderInterfaceShell();
        this.persistProject();
    }

    toggleAssistantPanel() {
        this.assistantVisible = !this.assistantVisible;
        if (this.assistantVisible && this.workspaceLayout === 'studio') {
            this.workspaceLayout = 'split';
            this.codeEditorVisible = true;
        }
        if (this.assistantVisible) {
            this.revealWorkspaceSurface();
        }

        this.renderWorkspaceState();
        this.renderInterfaceShell();
        this.persistProject();
    }

    renderWorkspaceState() {
        const visible = this.workspaceLayout !== 'studio';
        this.codeEditorVisible = visible;
        this.dom.codeEditor.classList.toggle('visible', visible);
        this.dom.appContainer.dataset.workspaceLayout = this.workspaceLayout;
        this.dom.appContainer.dataset.assistantVisible = String(this.assistantVisible);
        this.dom.assistantPanel.classList.toggle('visible', this.assistantVisible);
        this.dom.toggleCodeBtn.textContent = visible ? 'Hide Code' : 'Show Code';
        this.dom.toggleAssistantBtn.textContent = this.assistantVisible ? 'Hide AI' : 'Show AI';

        document.querySelectorAll('.code-control-btn').forEach((button) => {
            button.classList.toggle('visible', visible);
        });

        [
            ['studioLayoutBtn', 'studio'],
            ['splitLayoutBtn', 'split'],
            ['codeLayoutBtn', 'code']
        ].forEach(([id, mode]) => {
            this.dom[id].classList.toggle('active', this.workspaceLayout === mode);
            this.dom[id].setAttribute('aria-pressed', String(this.workspaceLayout === mode));
        });
    }

    buildDefaultCode() {
        const master = this.globalEffects.masterVolume.toFixed(2);
        const tempo = this.globalEffects.tempo;
        const delay = this.globalEffects.delay.toFixed(2);
        const filter = (1200 + this.globalEffects.filter * 4800).toFixed(0);
        const activeScene = this.scenePresets[this.activeScene]?.label || 'Custom';
        const kickSummary = this.formatStepSummary(this.sequenceConfig.kickSteps);
        const snareSummary = this.formatStepSummary(this.sequenceConfig.snareSteps);
        const hatSummary = this.formatStepSummary(this.sequenceConfig.hatSteps);
        const kickPattern = this.buildSamplePattern(this.sequenceConfig.kickSteps, 'bd');
        const snarePattern = this.buildSamplePattern(this.sequenceConfig.snareSteps, 'sd');
        const hatPattern = this.buildSamplePattern(this.sequenceConfig.hatSteps, 'hh');
        const percPattern = this.buildSamplePattern(this.sequenceConfig.percSteps, 'cp');
        const safeProjectName = this.sanitizeCommentText(this.projectMeta.name || 'Untitled Session');
        const arrangementComment = this.arrangement
            .map((section, index) => `// ${index + 1}. ${this.sanitizeCommentText(section.name)} - ${section.bars} bars (${this.scenePresets[section.sceneId]?.label || 'Scene'})`)
            .join('\n');
        const rhythmComment = `// Kick steps: ${kickSummary}\n// Snare steps: ${snareSummary}\n// Hat steps: ${hatSummary}\n`;
        const vocalComment = this.sampleState.vocal.fileName
            ? `// Vocal sample loaded locally: ${this.sanitizeCommentText(this.sampleState.vocal.fileName)}\n// Trigger steps: ${this.sequenceConfig.vocalSteps.join(', ')}\n`
            : `// Vocal layer currently uses the built-in factory starter texture.\n// Trigger steps: ${this.sequenceConfig.vocalSteps.join(', ')}\n`;
        const fxComment = this.sampleState.fx.fileName
            ? `// FX sample loaded locally: ${this.sanitizeCommentText(this.sampleState.fx.fileName)}\n// FX trigger steps: ${this.sequenceConfig.fxSteps.join(', ') || 'none'}\n`
            : `// FX lane currently uses the built-in factory stab layer.\n// FX trigger steps: ${this.sequenceConfig.fxSteps.join(', ') || 'none'}\n`;
        const textureComment = this.sampleState.texture.fileName
            ? `// Texture sample loaded locally: ${this.sanitizeCommentText(this.sampleState.texture.fileName)}\n// Texture trigger steps: ${this.sequenceConfig.textureSteps.join(', ') || 'none'}\n`
            : `// Texture lane currently uses the built-in factory airy pulse.\n// Texture trigger steps: ${this.sequenceConfig.textureSteps.join(', ') || 'none'}\n`;
        const percComment = this.sampleState.perc.fileName
            ? `// Perc sample loaded locally: ${this.sanitizeCommentText(this.sampleState.perc.fileName)}\n// Perc trigger steps: ${this.sequenceConfig.percSteps.join(', ') || 'none'}\n`
            : `// Perc lane currently uses the built-in factory one-shot click.\n// Perc trigger steps: ${this.sequenceConfig.percSteps.join(', ') || 'none'}\n`;
        const projectNotes = this.sanitizeCommentText((this.projectMeta.notes || 'No project notes yet.').replace(/\s*\n+\s*/g, ' | '));

        return `// Export-friendly Strudel sketch for the same arrangement
// Project: ${safeProjectName}
// Notes: ${projectNotes}
// Active scene: ${activeScene}
// Arrangement:
${arrangementComment}
${rhythmComment}
${vocalComment}
${fxComment}
${textureComment}
${percComment}

stack(
  s("${kickPattern}").gain(${(this.trackStates.kick.muted ? 0 : this.trackStates.kick.volume * this.globalEffects.masterVolume).toFixed(2)}),
  s("${snarePattern}").gain(${(this.trackStates.mainbreak.muted ? 0 : this.trackStates.mainbreak.volume * this.globalEffects.masterVolume * 0.72).toFixed(2)}),
  s("${hatPattern}").gain(${(this.trackStates.percussion.muted ? 0 : this.trackStates.percussion.volume * this.globalEffects.masterVolume * 0.65).toFixed(2)}),
  s("${percPattern}").gain(${(this.trackStates.percshot.muted ? 0 : this.trackStates.percshot.volume * this.globalEffects.masterVolume * 0.38).toFixed(2)}),
  note("c2 c2 fs2 fs2 g#2 g#2 c3 c3").s("sawtooth").gain(${(this.trackStates.bass.muted ? 0 : this.trackStates.bass.volume * this.globalEffects.masterVolume * 0.4).toFixed(2)}),
  note("<[cs4,f4,gs4] ~ [cs4,f4,gs4] ~ [fs4,a4,cs5] ~ [gs4,cs5,ds5] ~>").s("square").gain(${(this.trackStates.stabs.muted ? 0 : this.trackStates.stabs.volume * this.globalEffects.masterVolume * 0.28).toFixed(2)}),
  note("cs5 ~ e5 ~ fs5 ~ gs5 ~ a5 ~ gs5 ~ fs5 ~ e5 ~").s("triangle").gain(${(this.trackStates.lead.muted ? 0 : this.trackStates.lead.volume * this.globalEffects.masterVolume * 0.24).toFixed(2)})
)
  .lpf(${filter})
  .delay(${delay})
  .room(${this.globalEffects.reverb.toFixed(2)})
  .cpm(${(tempo / 4).toFixed(2)})
  .gain(${master})`;
    }

    renderStrudelStatus(message, type = 'info') {
        const colors = {
            info: '#0088ff',
            ready: '#00ff88',
            error: '#ff4444'
        };
        const wrapper = document.createElement('div');
        wrapper.style.padding = '20px';
        wrapper.style.borderRadius = '8px';
        wrapper.style.background = 'rgba(0,0,0,0.45)';
        wrapper.style.color = '#f5f5f5';
        wrapper.style.lineHeight = '1.6';

        const heading = document.createElement('p');
        heading.style.margin = '0 0 10px';
        heading.style.color = colors[type] || colors.info;
        heading.style.fontWeight = '700';
        heading.textContent = 'Playback status';

        const body = document.createElement('p');
        body.style.margin = '0';
        body.textContent = message;

        wrapper.append(heading, body);
        this.dom.strudelPanel.replaceChildren(wrapper);
    }

    async initializeStrudel() {
        if (this.strudelReady || typeof window.initStrudel !== 'function') {
            return this.strudelReady;
        }

        try {
            await Promise.resolve(window.initStrudel());
            this.strudelReady = true;
            return true;
        } catch (_) {
            return false;
        }
    }

    syncDefaultCodeFromControls() {
        this.defaultCode = this.buildDefaultCode();

        if (!this.userHasCustomCode) {
            this.dom.codeTextarea.value = this.defaultCode;
        }

        this.queueExportPanelRefresh();
    }

    async togglePlayStop() {
        if (this.isPlaying) {
            this.stop();
            return;
        }

        const didStart = await this.play();

        if (didStart) {
            this.syncTransportButton();
        }
    }

    syncTransportButton() {
        const button = this.dom.playStopBtn;
        const playIcon = button.querySelector('.play-icon');
        const playText = button.querySelector('.play-text');
        button.classList.toggle('playing', this.isPlaying);
        playIcon.textContent = this.isPlaying ? '||' : '>';
        playText.textContent = this.isPlaying ? 'Stop' : 'Play';
    }

    getRecordingMimeType() {
        const candidates = [
            'audio/webm;codecs=opus',
            'audio/webm',
            'audio/ogg;codecs=opus',
            'audio/ogg'
        ];

        return candidates.find((mimeType) => window.MediaRecorder?.isTypeSupported?.(mimeType)) || '';
    }

    updateRecordingButton() {
        const label = this.dom.recordBtn.querySelector('.record-text');

        if (this.isRecording) {
            this.dom.recordBtn.classList.add('recording');
            label.textContent = 'Stop Rec';
            return;
        }

        this.dom.recordBtn.classList.remove('recording');
        label.textContent = 'Record';
    }

    async toggleRecording() {
        if (this.isRecording) {
            this.stopRecording();
            return;
        }

        await this.startRecording();
    }

    async startRecording() {
        if (!window.MediaRecorder) {
            this.showNotification('Recording is not supported in this browser.', 'warning');
            return;
        }

        await this.ensureImportedLanesReady();
        await this.engine.ensureAudioContext();
        const stream = this.engine.getRecordingStream();
        if (!stream) {
            this.showNotification('Recording stream is not available yet.', 'error');
            return;
        }

        this.recordingMimeType = this.getRecordingMimeType();

        try {
            this.recordedChunks = [];
            this.mediaRecorder = this.recordingMimeType
                ? new MediaRecorder(stream, { mimeType: this.recordingMimeType })
                : new MediaRecorder(stream);
        } catch (error) {
            console.error('Recorder setup failed:', error);
            this.showNotification(`Recording failed to start: ${error.message}`, 'error');
            return;
        }

        this.mediaRecorder.addEventListener('dataavailable', (event) => {
            if (event.data?.size) {
                this.recordedChunks.push(event.data);
            }
        });

        this.mediaRecorder.addEventListener('stop', () => {
            if (!this.recordedChunks.length) {
                this.showNotification('Recording stopped, but no audio was captured.', 'warning');
                return;
            }

            const extension = this.recordingMimeType.includes('ogg') ? 'ogg' : 'webm';
            const blob = new Blob(this.recordedChunks, {
                type: this.recordingMimeType || 'audio/webm'
            });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            const safeLabel = (this.recordingOptions.takeLabel || this.projectMeta.name || 'strudel-take')
                .toLowerCase()
                .replace(/[^\w-]+/g, '-')
                .replace(/^-+|-+$/g, '');

            link.href = url;
            link.download = `${safeLabel || 'strudel-take'}-${Date.now()}.${extension}`;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(url);

            this.showNotification('Recording exported.', 'success');
        }, { once: true });

        this.mediaRecorder.start();
        this.isRecording = true;
        this.updateRecordingButton();

        if (!this.isPlaying) {
            const started = await this.play();
            if (!started) {
                this.stopRecording(true);
                return;
            }
            this.syncTransportButton();
        }

        this.renderStrudelStatus('Recording the local Web Audio mix. Press Stop Rec to export the take.', 'ready');
        this.showNotification('Recording started.', 'info');
    }

    stopRecording(silent = false) {
        if (!this.mediaRecorder || this.mediaRecorder.state === 'inactive') {
            this.isRecording = false;
            this.updateRecordingButton();
            return;
        }

        this.mediaRecorder.stop();
        this.isRecording = false;
        this.updateRecordingButton();

        if (!silent) {
            this.renderStrudelStatus('Recording stopped. Exporting the captured take now.', 'info');
        }
    }

    async play() {
        try {
            await this.ensureImportedLanesReady();
            await this.engine.start();
            this.isPlaying = true;
            this.startVisualTransport();
            this.renderStrudelStatus('Local Web Audio playback is running. The Strudel panel remains available for editing and export.', 'ready');
            return true;
        } catch (error) {
            console.error('Playback failed:', error);
            this.renderStrudelStatus(`Playback failed: ${error.message}`, 'error');
            this.showNotification(`Playback failed: ${error.message}`, 'error');
            return false;
        }
    }

    stop() {
        this.isPlaying = false;
        this.engine.stop();
        this.stopVisualTransport();
        if (this.isRecording) {
            this.stopRecording(true);
        }
        this.syncTransportButton();
        this.renderStrudelStatus('Playback stopped. Press Play to start the local audio engine again.', 'info');
    }

    startVisualTransport() {
        this.stopVisualTransport();

        this.updateInterval = setInterval(() => {
            this.currentTime += 0.1;
            if (this.currentTime >= this.totalTime) {
                if (this.isRecording && this.recordingOptions.autoStopAtEnd) {
                    this.currentTime = this.totalTime;
                    this.stopRecording(true);
                    this.stop();
                    this.showNotification('Recording stopped automatically at the end of the arrangement.', 'success');
                    return;
                }

                this.currentTime = 0;
            }
            this.updateTimeDisplay();
            this.updateProgress();
            this.updateTimelineMarker();
        }, 100);

        this.beatInterval = setInterval(() => {
            this.updateBeatIndicator();
        }, (60 / this.globalEffects.tempo) * 250);
    }

    stopVisualTransport() {
        if (this.updateInterval) {
            clearInterval(this.updateInterval);
            this.updateInterval = null;
        }

        if (this.beatInterval) {
            clearInterval(this.beatInterval);
            this.beatInterval = null;
        }

        document.querySelectorAll('.beat-indicator').forEach((indicator) => {
            indicator.classList.remove('active');
        });
    }

    updateTimeDisplay() {
        this.dom.currentTime.textContent = this.formatTime(this.currentTime);
        this.dom.totalTime.textContent = this.formatTime(this.totalTime);
    }

    updateProgress() {
        const percentage = (this.currentTime / Math.max(1, this.totalTime)) * 100;
        this.dom.progressFill.style.width = `${percentage}%`;
    }

    updateTimelineMarker() {
        if (!this.dom.timelineMarker) {
            return;
        }

        const percentage = (this.currentTime / Math.max(1, this.totalTime)) * 100;
        this.dom.timelineMarker.style.left = `${percentage}%`;
    }

    updateBeatIndicator() {
        document.querySelectorAll('.beat-indicator').forEach((indicator) => {
            indicator.classList.remove('active');
        });

        const currentBeatEl = document.querySelector(`[data-beat="${this.currentBeat}"]`);
        if (currentBeatEl) {
            currentBeatEl.classList.add('active');
        }

        this.currentBeat = (this.currentBeat % 4) + 1;
        if (this.currentBeat === 1) {
            this.currentCycle += 1;
            this.dom.cycleNumber.textContent = this.currentCycle;
        }
    }

    toggleMute(trackId, button, trackControl) {
        this.trackStates[trackId].muted = !this.trackStates[trackId].muted;

        if (this.trackStates[trackId].muted) {
            button.classList.add('active');
            button.textContent = 'Unmute';
            trackControl.classList.add('muted');
        } else {
            button.classList.remove('active');
            button.textContent = 'Mute';
            trackControl.classList.remove('muted');
        }

        this.engine.syncMix();
        this.markSceneCustom();
        this.syncDefaultCodeFromControls();
        this.persistProject();
    }

    toggleSolo(trackId, button, trackControl) {
        this.trackStates[trackId].solo = !this.trackStates[trackId].solo;
        button.classList.toggle('active', this.trackStates[trackId].solo);
        button.textContent = this.trackStates[trackId].solo ? 'Soloed' : 'Solo';
        trackControl.classList.toggle('soloed', this.trackStates[trackId].solo);
        this.engine.syncMix();
        this.markSceneCustom();
        this.persistProject();
    }

    updateVolumeDisplay(element, value) {
        element.textContent = `${value}%`;
    }

    updatePanDisplay(element, value) {
        const numeric = Number(value);
        if (numeric === 0) {
            element.textContent = 'C';
            return;
        }

        const side = numeric < 0 ? 'L' : 'R';
        element.textContent = `${side}${Math.abs(numeric)}%`;
    }

    updateTempoDisplay(element, value) {
        element.textContent = `${value} BPM`;
    }

    updateEffectDisplay(element, value) {
        element.textContent = `${value}%`;
    }

    updateVolumeDisplays() {
        document.querySelectorAll('.track-volume-slider').forEach((slider) => {
            this.updateVolumeDisplay(slider.nextElementSibling, slider.value);
        });

        document.querySelectorAll('.track-pan-slider').forEach((slider) => {
            this.updatePanDisplay(slider.nextElementSibling, slider.value);
        });

        this.updateVolumeDisplay(this.dom.masterVolume.nextElementSibling, this.dom.masterVolume.value);
        this.updateTempoDisplay(this.dom.tempoSlider.nextElementSibling, this.dom.tempoSlider.value);
    }

    updateEffectDisplays() {
        this.updateEffectDisplay(this.dom.reverbSlider.nextElementSibling, this.dom.reverbSlider.value);
        this.updateEffectDisplay(this.dom.delaySlider.nextElementSibling, this.dom.delaySlider.value);
        this.updateEffectDisplay(this.dom.filterSlider.nextElementSibling, this.dom.filterSlider.value);
        this.updateEffectDisplay(this.dom.vocalStartSlider.nextElementSibling, this.dom.vocalStartSlider.value);
        this.updateEffectDisplay(this.dom.vocalEndSlider.nextElementSibling, this.dom.vocalEndSlider.value);
        this.updateEffectDisplay(this.dom.vocalRateSlider.nextElementSibling, this.dom.vocalRateSlider.value);
        this.updateEffectDisplay(this.dom.fxStartSlider.nextElementSibling, this.dom.fxStartSlider.value);
        this.updateEffectDisplay(this.dom.fxEndSlider.nextElementSibling, this.dom.fxEndSlider.value);
        this.updateEffectDisplay(this.dom.fxRateSlider.nextElementSibling, this.dom.fxRateSlider.value);
        this.updateEffectDisplay(this.dom.textureStartSlider.nextElementSibling, this.dom.textureStartSlider.value);
        this.updateEffectDisplay(this.dom.textureEndSlider.nextElementSibling, this.dom.textureEndSlider.value);
        this.updateEffectDisplay(this.dom.textureRateSlider.nextElementSibling, this.dom.textureRateSlider.value);
        this.updateEffectDisplay(this.dom.percStartSlider.nextElementSibling, this.dom.percStartSlider.value);
        this.updateEffectDisplay(this.dom.percEndSlider.nextElementSibling, this.dom.percEndSlider.value);
        this.updateEffectDisplay(this.dom.percRateSlider.nextElementSibling, this.dom.percRateSlider.value);
    }

    toggleCodeEditor() {
        if (this.workspaceLayout === 'studio') {
            this.setWorkspaceLayout('split');
            return;
        }

        this.setWorkspaceLayout('studio');
    }

    async updateCode() {
        this.userHasCustomCode = true;
        await this.initializeStrudel();

        if (this.strudelReady && typeof window.strudel?.evaluate === 'function' && typeof window.strudel?.hush === 'function') {
            try {
                window.strudel.hush();
                await window.strudel.evaluate(this.dom.codeTextarea.value);
                this.renderStrudelStatus('Custom Strudel code evaluated in the code panel. The studio transport still runs the built-in audio engine, so keep using Play for the main mix.', 'ready');
                this.showNotification('Custom Strudel code evaluated.', 'success');
                this.persistProject();
                return;
            } catch (error) {
                this.renderStrudelStatus(`Custom Strudel code could not be evaluated: ${error.message}. Local playback still works.`, 'error');
                this.showNotification('Custom Strudel code failed, but local playback is still available.', 'warning');
                this.persistProject();
                return;
            }
        }

        this.renderStrudelStatus('Code updated for export. Local playback is still driven by the built-in audio engine.', 'info');
        this.showNotification('Code updated for export.', 'info');
        this.persistProject();
    }

    resetCode() {
        this.userHasCustomCode = false;
        this.defaultCode = this.buildDefaultCode();
        this.dom.codeTextarea.value = this.defaultCode;
        this.renderStrudelStatus('Generated export code restored. Local playback remains available on Play.', 'info');
        this.showNotification('Code reset to generated defaults.', 'info');
        this.persistProject();
    }

    exportCode() {
        const code = this.dom.codeTextarea.value;
        const blob = new Blob([code], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        const safeName = (this.projectMeta.name || 'strudel-session')
            .toLowerCase()
            .replace(/[^\w-]+/g, '-')
            .replace(/^-+|-+$/g, '');

        link.href = url;
        link.download = `${safeName || 'strudel-session'}.js`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);

        this.showNotification('Code exported successfully.', 'success');
    }

    showNotification(message, type = 'info') {
        const notification = document.createElement('div');
        notification.className = `notification notification--${type}`;
        notification.textContent = message;

        document.body.appendChild(notification);

        setTimeout(() => {
            notification.style.transform = 'translateX(0)';
        }, 20);

        setTimeout(() => {
            notification.style.transform = 'translateX(100%)';
            setTimeout(() => {
                notification.remove();
            }, 300);
        }, 2800);
    }
}

document.addEventListener('DOMContentLoaded', () => {
    window.prodigyApp = new ProdigyStrudelApp();
});
