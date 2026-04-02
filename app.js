class SimpleRaveEngine {
    constructor(app) {
        this.app = app;
        this.audioContext = null;
        this.masterGain = null;
        this.delayNode = null;
        this.feedbackGain = null;
        this.filterNode = null;
        this.mediaDestination = null;
        this.schedulerId = null;
        this.nextStepTime = 0;
        this.stepIndex = 0;
        this.isRunning = false;
        this.noiseBuffer = null;
        this.activeNodes = new Set();
    }

    async ensureAudioContext() {
        if (!this.audioContext) {
            const Context = window.AudioContext || window.webkitAudioContext;
            this.audioContext = new Context();

            this.masterGain = this.audioContext.createGain();
            this.filterNode = this.audioContext.createBiquadFilter();
            this.filterNode.type = 'lowpass';
            this.delayNode = this.audioContext.createDelay(0.6);
            this.feedbackGain = this.audioContext.createGain();
            this.mediaDestination = this.audioContext.createMediaStreamDestination();

            this.masterGain.connect(this.filterNode);
            this.filterNode.connect(this.delayNode);
            this.filterNode.connect(this.audioContext.destination);
            this.filterNode.connect(this.mediaDestination);
            this.delayNode.connect(this.feedbackGain);
            this.feedbackGain.connect(this.delayNode);
            this.delayNode.connect(this.audioContext.destination);
            this.delayNode.connect(this.mediaDestination);

            this.noiseBuffer = this.createNoiseBuffer();
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

    syncMix() {
        if (!this.audioContext) {
            return;
        }

        const { masterVolume, delay, filter } = this.app.globalEffects;
        const now = this.audioContext.currentTime;

        this.masterGain.gain.setTargetAtTime(masterVolume, now, 0.02);
        this.delayNode.delayTime.setTargetAtTime(Math.max(0.08, delay * 0.45), now, 0.02);
        this.feedbackGain.gain.setTargetAtTime(Math.min(0.55, delay * 0.5), now, 0.02);
        this.filterNode.frequency.setTargetAtTime(800 + filter * 8000, now, 0.02);
    }

    trackLevel(trackId) {
        const track = this.app.trackStates[trackId];
        return track.muted ? 0 : track.volume;
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
        gain.connect(this.masterGain);
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
        gain.connect(this.masterGain);
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
        noiseGain.connect(this.masterGain);
        bodyGain.connect(this.masterGain);

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
        gain.connect(this.masterGain);

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
            gain.connect(this.masterGain);
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
        gain.connect(this.masterGain);

        osc.start(time);
        this.registerNode(osc, time + 0.24);
    }

    scheduleVocalPulse(time) {
        const level = this.trackLevel('vocal');
        if (level <= 0) {
            return;
        }

        const vocalSample = this.app.sampleState.vocal;

        if (vocalSample.buffer) {
            const source = this.audioContext.createBufferSource();
            const filter = this.audioContext.createBiquadFilter();
            const gain = this.audioContext.createGain();
            const startPoint = vocalSample.buffer.duration * vocalSample.start;
            const endPoint = vocalSample.buffer.duration * vocalSample.end;
            const duration = Math.max(0.05, endPoint - startPoint);

            source.buffer = vocalSample.buffer;
            source.playbackRate.setValueAtTime(vocalSample.rate, time);
            filter.type = 'bandpass';
            filter.frequency.value = 1400;
            filter.Q.value = 1.2;

            gain.gain.setValueAtTime(0.0001, time);
            gain.gain.linearRampToValueAtTime(0.42 * level, time + 0.01);
            gain.gain.exponentialRampToValueAtTime(0.0001, time + Math.min(duration, 0.48));

            source.connect(filter);
            filter.connect(gain);
            gain.connect(this.masterGain);
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
        gain.connect(this.masterGain);
        source.start(time);
        this.registerNode(source, time + 0.22);
    }

    scheduleFxPulse(time) {
        const level = this.trackLevel('fx');
        if (level <= 0) {
            return;
        }

        const fxSample = this.app.sampleState.fx;

        if (fxSample.buffer) {
            const source = this.audioContext.createBufferSource();
            const filter = this.audioContext.createBiquadFilter();
            const gain = this.audioContext.createGain();
            const startPoint = fxSample.buffer.duration * fxSample.start;
            const endPoint = fxSample.buffer.duration * fxSample.end;
            const duration = Math.max(0.05, endPoint - startPoint);

            source.buffer = fxSample.buffer;
            source.playbackRate.setValueAtTime(fxSample.rate, time);
            filter.type = 'highpass';
            filter.frequency.value = 1200;
            filter.Q.value = 0.8;

            gain.gain.setValueAtTime(0.0001, time);
            gain.gain.linearRampToValueAtTime(0.36 * level, time + 0.01);
            gain.gain.exponentialRampToValueAtTime(0.0001, time + Math.min(duration, 0.52));

            source.connect(filter);
            filter.connect(gain);
            gain.connect(this.masterGain);
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
        gain.connect(this.masterGain);
        osc.start(time);
        this.registerNode(osc, time + 0.22);
    }

    scheduleBreakGhosts(time, step) {
        const level = this.trackLevel('mainbreak');
        if (level <= 0) {
            return;
        }

        if ([2, 6, 10, 14].includes(step)) {
            this.scheduleHat(time, false);
        }

        if ([4, 12].includes(step)) {
            this.scheduleSnare(time);
        }
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

        if ([0, 4, 8, 12].includes(step)) {
            this.scheduleKick(time);
        }
        if ([4, 12].includes(step)) {
            this.scheduleSnare(time);
        }

        this.scheduleHat(time, step % 2 === 0);
        this.scheduleBreakGhosts(time, step);

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
        this.strudelReady = false;
        this.userHasCustomCode = false;
        this.isRecording = false;
        this.mediaRecorder = null;
        this.recordedChunks = [];
        this.recordingMimeType = '';
        this.activeScene = 'main';

        this.trackStates = {
            mainbreak: { volume: 0.9, muted: false },
            kick: { volume: 0.8, muted: false },
            bass: { volume: 0.7, muted: false },
            stabs: { volume: 0.6, muted: false },
            lead: { volume: 0.5, muted: false },
            vocal: { volume: 0.8, muted: false },
            fx: { volume: 0.55, muted: false },
            percussion: { volume: 0.5, muted: false }
        };

        this.globalEffects = {
            masterVolume: 0.8,
            tempo: 131,
            reverb: 0.3,
            delay: 0.25,
            filter: 0.5
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
                    percussion: { volume: 0.32, muted: false }
                },
                sequenceConfig: { vocalSteps: [16], fxSteps: [] }
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
                    percussion: { volume: 0.5, muted: false }
                },
                sequenceConfig: { vocalSteps: [8, 16], fxSteps: [4, 12] }
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
                    percussion: { volume: 0.26, muted: true }
                },
                sequenceConfig: { vocalSteps: [4, 8, 12, 16], fxSteps: [12] }
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
                    percussion: { volume: 0.6, muted: false }
                },
                sequenceConfig: { vocalSteps: [4, 8, 12, 14, 16], fxSteps: [8, 12, 16] }
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
                    percussion: { volume: 0.66, muted: false }
                },
                sequenceConfig: { vocalSteps: [2, 4, 8, 10, 12, 16], fxSteps: [4, 8, 12, 16] }
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
                    percussion: { volume: 0.24, muted: false }
                },
                sequenceConfig: { vocalSteps: [8, 16], fxSteps: [16] }
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

        this.sequenceConfig = {
            vocalSteps: [8, 16],
            fxSteps: [4, 12]
        };

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

        this.sampleState = {
            vocal: {
                buffer: null,
                fileName: '',
                start: 0,
                end: 1,
                rate: 1
            },
            fx: {
                buffer: null,
                fileName: '',
                start: 0,
                end: 1,
                rate: 1
            }
        };

        this.projectStorageKey = 'strudel-studio-project-v2';
        this.legacyProjectStorageKey = 'strudel-test-project-v1';

        this.dom = this.bindDom();
        this.defaultCode = this.buildDefaultCode();
        this.engine = new SimpleRaveEngine(this);
        this.init();
    }

    bindDom() {
        return {
            playStopBtn: document.getElementById('playStopBtn'),
            recordBtn: document.getElementById('recordBtn'),
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
            sampleStatus: document.getElementById('sampleStatus'),
            auditionVocalBtn: document.getElementById('auditionVocalBtn'),
            clearVocalBtn: document.getElementById('clearVocalBtn'),
            vocalStepGrid: document.getElementById('vocalStepGrid'),
            fxSampleInput: document.getElementById('fxSampleInput'),
            fxStepInput: document.getElementById('fxStepInput'),
            fxStartSlider: document.getElementById('fxStartSlider'),
            fxEndSlider: document.getElementById('fxEndSlider'),
            fxRateSlider: document.getElementById('fxRateSlider'),
            fxStatus: document.getElementById('fxStatus'),
            auditionFxBtn: document.getElementById('auditionFxBtn'),
            clearFxBtn: document.getElementById('clearFxBtn'),
            fxStepGrid: document.getElementById('fxStepGrid'),
            saveProjectBtn: document.getElementById('saveProjectBtn'),
            exportProjectBtn: document.getElementById('exportProjectBtn'),
            importProjectBtn: document.getElementById('importProjectBtn'),
            importProjectInput: document.getElementById('importProjectInput'),
            sceneDescription: document.getElementById('sceneDescription'),
            toggleCodeBtn: document.getElementById('toggleCodeBtn'),
            updateCodeBtn: document.getElementById('updateCodeBtn'),
            resetCodeBtn: document.getElementById('resetCodeBtn'),
            exportCodeBtn: document.getElementById('exportCodeBtn'),
            codeEditor: document.getElementById('codeEditor'),
            codeTextarea: document.getElementById('strudelCode'),
            strudelPanel: document.getElementById('strudelRepl'),
            sceneButtons: Array.from(document.querySelectorAll('.scene-btn')),
            exampleLibraryList: document.getElementById('exampleLibraryList')
        };
    }

    init() {
        this.buildVocalStepButtons();
        this.buildFxStepButtons();
        this.renderExampleLibrary();
        this.loadSavedProject();
        if (!this.userHasCustomCode || !this.dom.codeTextarea.value) {
            this.dom.codeTextarea.value = this.defaultCode;
        }
        this.renderStrudelStatus('Local audio engine ready on Play. Strudel code remains editable and exportable from this panel.', 'info');
        this.setupEventListeners();
        this.syncDomFromState();
        this.updateTimeDisplay();
        this.updateVolumeDisplays();
        this.updateEffectDisplays();
        this.updateRecordingButton();
        this.updateSampleStatus();
        this.updateFxStatus();
        this.setupCodeEditor();
        this.initializeStrudel();
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

    formatTime(seconds) {
        const minutes = Math.floor(seconds / 60);
        const remainder = Math.floor(seconds % 60);
        return `${minutes}:${String(remainder).padStart(2, '0')}`;
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

    syncDomFromState() {
        this.dom.masterVolume.value = Math.round(this.globalEffects.masterVolume * 100);
        this.dom.tempoSlider.value = this.globalEffects.tempo;
        this.dom.reverbSlider.value = Math.round(this.globalEffects.reverb * 100);
        this.dom.delaySlider.value = Math.round(this.globalEffects.delay * 100);
        this.dom.filterSlider.value = Math.round(this.globalEffects.filter * 100);
        this.dom.vocalStepInput.value = this.sequenceConfig.vocalSteps.join(',');
        this.dom.vocalStartSlider.value = Math.round(this.sampleState.vocal.start * 100);
        this.dom.vocalEndSlider.value = Math.round(this.sampleState.vocal.end * 100);
        this.dom.vocalRateSlider.value = Math.round(this.sampleState.vocal.rate * 100);
        this.dom.fxStepInput.value = this.sequenceConfig.fxSteps.join(',');
        this.dom.fxStartSlider.value = Math.round(this.sampleState.fx.start * 100);
        this.dom.fxEndSlider.value = Math.round(this.sampleState.fx.end * 100);
        this.dom.fxRateSlider.value = Math.round(this.sampleState.fx.rate * 100);

        document.querySelectorAll('.track-volume-slider').forEach((slider) => {
            const trackId = slider.dataset.track;
            const trackState = this.trackStates[trackId];
            if (trackState) {
                slider.value = Math.round(trackState.volume * 100);
                const trackControl = slider.closest('.track-control');
                const muteButton = trackControl?.querySelector('.mute-btn');
                if (muteButton) {
                    muteButton.classList.toggle('active', trackState.muted);
                    muteButton.textContent = trackState.muted ? 'Unmute' : 'Mute';
                }
                trackControl?.classList.toggle('muted', trackState.muted);
            }
        });

        this.renderVocalStepGrid();
        this.renderFxStepGrid();
        this.renderSceneState();
        this.renderArrangementTimeline();
        this.renderArrangementEditor();
        this.refreshTimelineMetrics();
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

    updateSampleStatus() {
        const vocal = this.sampleState.vocal;
        const stepSummary = this.sequenceConfig.vocalSteps.join(', ') || 'none';

        if (vocal.buffer) {
            const start = Math.round(vocal.start * 100);
            const end = Math.round(vocal.end * 100);
            const rate = Math.round(vocal.rate * 100);
            this.dom.sampleStatus.textContent = `${vocal.fileName} loaded. Triggering on steps ${stepSummary}. Slice ${start}% to ${end}% at ${rate}% speed.`;
            return;
        }

        this.dom.sampleStatus.textContent = `Using the built-in placeholder vocal texture on steps ${stepSummary}. Import a sample to hear real vocal chops.`;
    }

    updateFxStatus() {
        const fx = this.sampleState.fx;
        const stepSummary = this.sequenceConfig.fxSteps.join(', ') || 'none';

        if (fx.buffer) {
            const start = Math.round(fx.start * 100);
            const end = Math.round(fx.end * 100);
            const rate = Math.round(fx.rate * 100);
            this.dom.fxStatus.textContent = `${fx.fileName} loaded. Triggering on steps ${stepSummary}. Slice ${start}% to ${end}% at ${rate}% speed.`;
            return;
        }

        this.dom.fxStatus.textContent = `Using the built-in synth stab texture on steps ${stepSummary}. Import a sample to turn this lane into your own FX or stab layer.`;
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

            if (section.sceneId === this.activeScene) {
                sectionElement.classList.add('is-active-scene');
            }

            if (isCurrent && this.isPlaying) {
                sectionElement.classList.add('is-current');
            }

            sectionElement.innerHTML = `
                <span class="section-label">${section.name}</span>
                <span class="section-time">${this.formatTime(startTime)}-${this.formatTime(endTime)}</span>
                <span class="section-meta">${section.bars} bars | ${this.scenePresets[section.sceneId]?.label || 'Scene'}</span>
            `;

            sectionElement.addEventListener('click', () => this.applyScenePreset(section.sceneId));
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

            const sceneOptions = Object.entries(this.scenePresets)
                .map(([sceneId, scene]) => `<option value="${sceneId}" ${sceneId === section.sceneId ? 'selected' : ''}>${scene.label}</option>`)
                .join('');

            row.innerHTML = `
                <div class="arrangement-field arrangement-field--index">#${index + 1}</div>
                <label class="arrangement-field">
                    <span class="form-label">Name</span>
                    <input class="form-control arrangement-name" type="text" value="${section.name}">
                </label>
                <label class="arrangement-field">
                    <span class="form-label">Scene</span>
                    <select class="form-control arrangement-scene">${sceneOptions}</select>
                </label>
                <label class="arrangement-field arrangement-field--bars">
                    <span class="form-label">Bars</span>
                    <input class="form-control arrangement-bars" type="number" min="1" value="${section.bars}">
                </label>
                <div class="arrangement-actions">
                    <button class="btn btn--secondary btn--sm arrangement-preview" type="button">Load</button>
                    <button class="btn btn--outline btn--sm arrangement-remove" type="button">Remove</button>
                </div>
            `;

            const nameInput = row.querySelector('.arrangement-name');
            const sceneSelect = row.querySelector('.arrangement-scene');
            const barsInput = row.querySelector('.arrangement-bars');
            const previewButton = row.querySelector('.arrangement-preview');
            const removeButton = row.querySelector('.arrangement-remove');

            nameInput.addEventListener('change', (event) => {
                this.updateArrangementSection(section.id, 'name', event.target.value);
            });

            sceneSelect.addEventListener('change', (event) => {
                this.updateArrangementSection(section.id, 'sceneId', event.target.value);
            });

            barsInput.addEventListener('change', (event) => {
                this.updateArrangementSection(section.id, 'bars', event.target.value);
            });

            previewButton.addEventListener('click', () => this.applyScenePreset(section.sceneId));
            removeButton.addEventListener('click', () => this.removeArrangementSection(section.id));

            editor.appendChild(row);
        });
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
                        <button class="btn btn--secondary btn--sm example-use" type="button">Use Example</button>
                        <button class="btn btn--outline btn--sm example-copy" type="button">Copy</button>
                    </div>
                </div>
                <pre class="example-code">${example.code.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>
            `;

            card.querySelector('.example-use').addEventListener('click', () => this.useExampleCode(example));
            card.querySelector('.example-copy').addEventListener('click', () => {
                this.copyText(example.code)
                    .then(() => this.showNotification(`${example.name} copied.`, 'success'))
                    .catch((error) => this.showNotification(`Could not copy example: ${error.message}`, 'error'));
            });

            this.dom.exampleLibraryList.appendChild(card);
        });
    }

    useExampleCode(example) {
        this.userHasCustomCode = true;
        this.dom.codeTextarea.value = example.code;

        if (!this.codeEditorVisible) {
            this.toggleCodeEditor();
        }

        this.persistProject();
        this.renderStrudelStatus(`${example.name} loaded into the code panel. Press Update to try it live.`, 'info');
        this.showNotification(`${example.name} loaded into the code panel.`, 'success');
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
            activeScene: this.activeScene,
            arrangement: this.arrangement,
            globalEffects: this.globalEffects,
            trackStates: this.trackStates,
            sequenceConfig: this.sequenceConfig,
            sampleSettings: {
                vocal: {
                    fileName: this.sampleState.vocal.fileName,
                    start: this.sampleState.vocal.start,
                    end: this.sampleState.vocal.end,
                    rate: this.sampleState.vocal.rate
                },
                fx: {
                    fileName: this.sampleState.fx.fileName,
                    start: this.sampleState.fx.start,
                    end: this.sampleState.fx.end,
                    rate: this.sampleState.fx.rate
                }
            },
            customCode: this.dom.codeTextarea.value,
            userHasCustomCode: this.userHasCustomCode
        };
    }

    applyProject(project) {
        if (typeof project.activeScene === 'string' && (this.scenePresets[project.activeScene] || project.activeScene === 'custom')) {
            this.activeScene = project.activeScene;
        }

        if (project.arrangement) {
            this.arrangement = this.normalizeArrangement(project.arrangement);
        }

        if (project.globalEffects) {
            this.globalEffects = {
                ...this.globalEffects,
                ...project.globalEffects
            };
        }

        if (project.trackStates) {
            this.trackStates = {
                ...this.trackStates,
                ...project.trackStates
            };
        }

        if (project.sequenceConfig?.vocalSteps) {
            this.sequenceConfig.vocalSteps = this.parseVocalSteps(project.sequenceConfig.vocalSteps.join(','));
        }

        if (project.sequenceConfig?.fxSteps) {
            this.sequenceConfig.fxSteps = this.parseVocalSteps(project.sequenceConfig.fxSteps.join(','));
        }

        if (project.sampleSettings?.vocal) {
            this.sampleState.vocal = {
                ...this.sampleState.vocal,
                ...project.sampleSettings.vocal,
                buffer: null
            };
        }

        if (project.sampleSettings?.fx) {
            this.sampleState.fx = {
                ...this.sampleState.fx,
                ...project.sampleSettings.fx,
                buffer: null
            };
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
        this.updateVolumeDisplays();
        this.updateEffectDisplays();
        this.updateSampleStatus();
        this.updateFxStatus();
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
        try {
            localStorage.setItem(this.projectStorageKey, JSON.stringify(this.serializeProject()));
        } catch (error) {
            console.warn('Could not persist project state:', error);
        }
    }

    async handleVocalSampleFile(file) {
        await this.engine.ensureAudioContext();
        const arrayBuffer = await file.arrayBuffer();
        const decoded = await this.engine.audioContext.decodeAudioData(arrayBuffer.slice(0));

        this.sampleState.vocal.buffer = decoded;
        this.sampleState.vocal.fileName = file.name;
        this.sampleState.vocal.start = 0;
        this.sampleState.vocal.end = 1;
        this.sampleState.vocal.rate = 1;

        this.syncDomFromState();
        this.updateEffectDisplays();
        this.updateSampleStatus();
        this.markSceneCustom();
        this.syncDefaultCodeFromControls();
        this.persistProject();
        this.showNotification(`Loaded vocal sample: ${file.name}`, 'success');
    }

    async handleFxSampleFile(file) {
        await this.engine.ensureAudioContext();
        const arrayBuffer = await file.arrayBuffer();
        const decoded = await this.engine.audioContext.decodeAudioData(arrayBuffer.slice(0));

        this.sampleState.fx.buffer = decoded;
        this.sampleState.fx.fileName = file.name;
        this.sampleState.fx.start = 0;
        this.sampleState.fx.end = 1;
        this.sampleState.fx.rate = 1;

        this.syncDomFromState();
        this.updateEffectDisplays();
        this.updateFxStatus();
        this.markSceneCustom();
        this.syncDefaultCodeFromControls();
        this.persistProject();
        this.showNotification(`Loaded FX sample: ${file.name}`, 'success');
    }

    clearVocalSample() {
        this.sampleState.vocal = {
            buffer: null,
            fileName: '',
            start: 0,
            end: 1,
            rate: 1
        };
        this.syncDomFromState();
        this.updateEffectDisplays();
        this.updateSampleStatus();
        this.markSceneCustom();
        this.syncDefaultCodeFromControls();
        this.persistProject();
        this.showNotification('Vocal sample cleared. Placeholder vocal texture is active again.', 'info');
    }

    clearFxSample() {
        this.sampleState.fx = {
            buffer: null,
            fileName: '',
            start: 0,
            end: 1,
            rate: 1
        };
        this.syncDomFromState();
        this.updateEffectDisplays();
        this.updateFxStatus();
        this.markSceneCustom();
        this.syncDefaultCodeFromControls();
        this.persistProject();
        this.showNotification('FX sample cleared. Built-in stab texture is active again.', 'info');
    }

    async auditionVocalSample() {
        await this.engine.ensureAudioContext();
        this.engine.scheduleVocalPulse(this.engine.audioContext.currentTime + 0.03);
        this.renderStrudelStatus('Playing a quick vocal preview from the current slice and rate settings.', 'ready');
    }

    async auditionFxSample() {
        await this.engine.ensureAudioContext();
        this.engine.scheduleFxPulse(this.engine.audioContext.currentTime + 0.03);
        this.renderStrudelStatus('Playing a quick FX preview from the current slice and rate settings.', 'ready');
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

        if (scene.sequenceConfig?.vocalSteps) {
            this.sequenceConfig.vocalSteps = [...scene.sequenceConfig.vocalSteps];
        }

        if (scene.sequenceConfig?.fxSteps) {
            this.sequenceConfig.fxSteps = [...scene.sequenceConfig.fxSteps];
        }

        this.syncDomFromState();
        this.updateVolumeDisplays();
        this.updateEffectDisplays();
        this.updateSampleStatus();
        this.updateFxStatus();
        this.engine.syncMix();
        this.syncDefaultCodeFromControls();
        this.persistProject();
        this.renderStrudelStatus(`${scene.label} scene loaded. ${scene.description}`, 'ready');
        this.showNotification(`${scene.label} scene loaded.`, 'success');
    }

    saveProjectToBrowser() {
        this.persistProject();
        this.showNotification('Project saved in this browser.', 'success');
    }

    exportProject() {
        const project = this.serializeProject();
        const blob = new Blob([JSON.stringify(project, null, 2)], { type: 'application/json;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = 'strudel-project.json';
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
        this.persistProject();
        this.showNotification('Project imported. Reload any audio sample files manually if needed.', 'success');
        this.renderStrudelStatus('Project imported. If the project used custom samples, reload them from disk to restore playback.', 'info');
    }

    setupEventListeners() {
        this.dom.playStopBtn.addEventListener('click', () => this.togglePlayStop());
        this.dom.recordBtn.addEventListener('click', () => this.toggleRecording());
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

        this.dom.sceneButtons.forEach((button) => {
            button.addEventListener('click', () => this.applyScenePreset(button.dataset.scene));
        });

        this.dom.addSectionBtn?.addEventListener('click', () => this.addArrangementSection());
        this.dom.resetArrangementBtn?.addEventListener('click', () => this.resetArrangement());

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
                this.markSceneCustom();
                this.syncDefaultCodeFromControls();
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

        this.dom.toggleCodeBtn.addEventListener('click', () => this.toggleCodeEditor());
        this.dom.updateCodeBtn.addEventListener('click', () => this.updateCode());
        this.dom.resetCodeBtn.addEventListener('click', () => this.resetCode());
        this.dom.exportCodeBtn.addEventListener('click', () => this.exportCode());
        this.dom.saveProjectBtn.addEventListener('click', () => this.saveProjectToBrowser());
        this.dom.exportProjectBtn.addEventListener('click', () => this.exportProject());
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
        this.dom.codeTextarea.addEventListener('input', () => {
            this.userHasCustomCode = true;
            this.persistProject();
        });
    }

    setupCodeEditor() {
        this.dom.codeEditor.classList.remove('visible');
        document.querySelectorAll('.code-control-btn').forEach((button) => {
            button.classList.remove('visible');
        });
    }

    buildDefaultCode() {
        const master = this.globalEffects.masterVolume.toFixed(2);
        const tempo = this.globalEffects.tempo;
        const delay = this.globalEffects.delay.toFixed(2);
        const filter = (1200 + this.globalEffects.filter * 4800).toFixed(0);
        const activeScene = this.scenePresets[this.activeScene]?.label || 'Custom';
        const arrangementComment = this.arrangement
            .map((section, index) => `// ${index + 1}. ${section.name} - ${section.bars} bars (${this.scenePresets[section.sceneId]?.label || 'Scene'})`)
            .join('\n');
        const vocalComment = this.sampleState.vocal.fileName
            ? `// Vocal sample loaded locally: ${this.sampleState.vocal.fileName}\n// Trigger steps: ${this.sequenceConfig.vocalSteps.join(', ')}\n`
            : `// Vocal layer currently uses the built-in placeholder texture.\n// Trigger steps: ${this.sequenceConfig.vocalSteps.join(', ')}\n`;
        const fxComment = this.sampleState.fx.fileName
            ? `// FX sample loaded locally: ${this.sampleState.fx.fileName}\n// FX trigger steps: ${this.sequenceConfig.fxSteps.join(', ') || 'none'}\n`
            : `// FX lane currently uses the built-in stab texture.\n// FX trigger steps: ${this.sequenceConfig.fxSteps.join(', ') || 'none'}\n`;

        return `// Export-friendly Strudel sketch for the same arrangement
// Active scene: ${activeScene}
// Arrangement:
${arrangementComment}
${vocalComment}
${fxComment}

stack(
  s("bd*4").gain(${(this.trackStates.kick.muted ? 0 : this.trackStates.kick.volume * this.globalEffects.masterVolume).toFixed(2)}),
  s("hh*8").gain(${(this.trackStates.percussion.muted ? 0 : this.trackStates.percussion.volume * this.globalEffects.masterVolume * 0.65).toFixed(2)}),
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

        this.dom.strudelPanel.innerHTML = `
            <div style="padding: 20px; border-radius: 8px; background: rgba(0,0,0,0.45); color: #f5f5f5; line-height: 1.6;">
                <p style="margin: 0 0 10px; color: ${colors[type] || colors.info}; font-weight: 700;">Playback status</p>
                <p style="margin: 0;">${message}</p>
            </div>
        `;
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
    }

    async togglePlayStop() {
        const button = this.dom.playStopBtn;
        const playIcon = button.querySelector('.play-icon');
        const playText = button.querySelector('.play-text');

        if (this.isPlaying) {
            this.stop();
            button.classList.remove('playing');
            playIcon.textContent = '>';
            playText.textContent = 'Play';
            return;
        }

        const didStart = await this.play();

        if (didStart) {
            button.classList.add('playing');
            playIcon.textContent = '||';
            playText.textContent = 'Stop';
        }
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

            link.href = url;
            link.download = `strudel-take-${Date.now()}.${extension}`;
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

            const button = this.dom.playStopBtn;
            button.classList.add('playing');
            button.querySelector('.play-icon').textContent = '||';
            button.querySelector('.play-text').textContent = 'Stop';
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
        this.renderStrudelStatus('Playback stopped. Press Play to start the local audio engine again.', 'info');
    }

    startVisualTransport() {
        this.stopVisualTransport();

        this.updateInterval = setInterval(() => {
            this.currentTime += 0.1;
            if (this.currentTime >= this.totalTime) {
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

        this.markSceneCustom();
        this.syncDefaultCodeFromControls();
        this.persistProject();
    }

    updateVolumeDisplay(element, value) {
        element.textContent = `${value}%`;
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
    }

    toggleCodeEditor() {
        this.codeEditorVisible = !this.codeEditorVisible;

        if (this.codeEditorVisible) {
            this.dom.codeEditor.classList.add('visible');
            this.dom.toggleCodeBtn.textContent = 'Hide Code';
            document.querySelectorAll('.code-control-btn').forEach((button) => {
                button.classList.add('visible');
            });
        } else {
            this.dom.codeEditor.classList.remove('visible');
            this.dom.toggleCodeBtn.textContent = 'Show Code';
            document.querySelectorAll('.code-control-btn').forEach((button) => {
                button.classList.remove('visible');
            });
        }
    }

    async updateCode() {
        this.userHasCustomCode = true;
        await this.initializeStrudel();

        if (this.strudelReady && typeof window.strudel?.evaluate === 'function' && typeof window.strudel?.hush === 'function') {
            try {
                window.strudel.hush();
                await window.strudel.evaluate(this.dom.codeTextarea.value);
                this.renderStrudelStatus('Custom Strudel code evaluated. If it is valid, you should hear the Strudel version as well as the local engine when Play is active.', 'ready');
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

        link.href = url;
        link.download = 'prodigy-everybody-strudel.js';
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
