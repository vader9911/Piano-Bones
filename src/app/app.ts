import { ChangeDetectionStrategy, Component, ElementRef, ViewChild, AfterViewInit, OnDestroy, computed, inject, signal } from '@angular/core';
import { TelemetryService } from './telemetry.service';
import * as THREE from 'three';
import { Midi } from '@tonejs/midi';
import * as Tone from 'tone';

interface SkeletonLine {
  line: THREE.Line;
  c1: number;
  c2: number;
}

interface ToneNote {
  midi: number;
  duration: number;
  time: number;
  name: string;
  velocity: number;
}

interface ToneTrack {
  notes: ToneNote[];
}

interface MidiNote {
  mesh: THREE.Mesh;
  midi: number;
  time: number;
  duration: number;
}

interface WebMidiMessageEvent {
  data: Uint8Array;
}

interface WebMidiInput {
  name?: string;
  onmidimessage?: (event: WebMidiMessageEvent) => void;
}

interface WebMidiAccess {
  inputs: {
    values: () => IterableIterator<WebMidiInput>;
  };
  onstatechange?: () => void;
}

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-root',
  imports: [],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App implements AfterViewInit, OnDestroy {
  telemetry = inject(TelemetryService);
  
  @ViewChild('threeContainer') threeContainer!: ElementRef<HTMLDivElement>;

  // Computed signals for template
  leftWristHeightCm = computed(() => this.telemetry.metrics().leftWristHeightCm.toFixed(1));
  rightWristHeightCm = computed(() => this.telemetry.metrics().rightWristHeightCm.toFixed(1));
  connected = computed(() => this.telemetry.connected());
  logs = computed(() => this.telemetry.logs().slice(0, 3)); // Only show top 3 logs
  midiTrackName = signal<string>('None Loaded');

  // Three.js state
  private scene!: THREE.Scene;
  private camera!: THREE.PerspectiveCamera;
  private renderer!: THREE.WebGLRenderer;
  private animationFrameId?: number;
  
  // Support up to 2 hands (0 = Left Hand, 1 = Right Hand)
  private landmarksMeshes: THREE.Mesh[][] = [[], []];
  private skeletonLinesList: SkeletonLine[][] = [[], []];

  // MIDI visualization & audio state
  private pianoKeys: THREE.Mesh[] = [];
  private fallingNotes: MidiNote[] = [];
  private midiStartTime = 0;
  private currentPauseTime = 0;
  isMidiPlaying = signal(false);
  midiLoaded = signal(false);
  private midiData: typeof Midi.prototype | null = null;
  private synth!: Tone.PolySynth;
  private noteMaterial = new THREE.MeshBasicMaterial({ color: 0x3b82f6, transparent: true, opacity: 0.8 }); // blue-500

  // HTML Virtual Keyboard State
  virtualKeys = signal<{ midi: number; name: string; isBlack: boolean; active: boolean }[]>([]);
  activePointers = new Map<number, number>(); // pointerId -> midi note
  volume = signal(0.5);

  // Keyboard range alignment guides toggle
  showAlignmentGuides = signal<boolean>(false);

  // Web MIDI API state
  connectedMidiDevices = signal<string[]>([]);
  midiSupport = signal<boolean>(true);

  // Hand simulation & collision tracking
  private handTriggeredMidiNotes: Set<number>[] = [new Set<number>(), new Set<number>()];

  ngAfterViewInit() {
    if (typeof window === 'undefined') return;
    this.synth = new Tone.PolySynth(Tone.Synth).toDestination();
    Tone.Destination.volume.value = Tone.gainToDb(this.volume());
    this.initVirtualKeyboard();
    this.initThreeJs();
    this.initMidiInput();
    this.animate();
  }

  private initMidiInput() {
    const nav = navigator as unknown as { requestMIDIAccess?: () => Promise<WebMidiAccess> };
    if (typeof navigator === 'undefined' || !nav.requestMIDIAccess) {
      this.midiSupport.set(false);
      return;
    }

    nav.requestMIDIAccess()
      .then((midiAccess: WebMidiAccess) => {
        this.setupMidiAccess(midiAccess);
      })
      .catch((err) => {
        console.warn('Web MIDI Access denied or not supported:', err);
        this.midiSupport.set(false);
      });
  }

  private setupMidiAccess(midiAccess: WebMidiAccess) {
    const updateInputs = () => {
      const inputs = Array.from(midiAccess.inputs.values());
      const names = inputs.map(input => input.name || 'Unknown Device');
      this.connectedMidiDevices.set(names);

      // Bind message handlers
      inputs.forEach(input => {
        input.onmidimessage = (event: WebMidiMessageEvent) => {
          this.handleMidiMessage(event);
        };
      });
    };

    midiAccess.onstatechange = () => {
      updateInputs();
    };

    updateInputs();
  }

  private handleMidiMessage(event: WebMidiMessageEvent) {
    const data = event.data;
    if (!data || data.length < 2) return;

    const command = data[0] & 0xf0;
    const midiNote = data[1];
    const velocity = data.length > 2 ? data[2] : 0;

    // A0 (21) to C8 (108)
    if (midiNote < 21 || midiNote > 108) return;

    const notes = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    const octave = Math.floor((midiNote / 12) - 1);
    const noteName = notes[midiNote % 12];
    const fullName = `${noteName}${octave}`;

    if (command === 0x90 && velocity > 0) {
      // Note On
      this.playNote(midiNote, fullName);
    } else if (command === 0x80 || (command === 0x90 && velocity === 0)) {
      // Note Off
      this.stopNote(midiNote, fullName);
    }
  }

  private initVirtualKeyboard() {
    const keys = [];
    const notes = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    // 88 keys from A0 (midi 21) to C8 (midi 108)
    for (let i = 21; i <= 108; i++) {
      const octave = Math.floor((i / 12) - 1);
      const noteName = notes[i % 12];
      const isBlack = noteName.includes('#');
      keys.push({ midi: i, name: `${noteName}${octave}`, isBlack, active: false });
    }
    this.virtualKeys.set(keys);
  }

  onVolumeChange(event: Event) {
    const input = event.target as HTMLInputElement;
    const val = parseFloat(input.value);
    this.volume.set(val);
    Tone.Destination.volume.value = Tone.gainToDb(val);
  }

  toggleAlignmentGuides() {
    this.showAlignmentGuides.set(!this.showAlignmentGuides());
  }

  getGuideLines(): { percent: number; label: string; color: string }[] {
    if (!this.pianoKeys || this.pianoKeys.length === 0) {
      return [];
    }

    const guides: { percent: number; label: string; color: string }[] = [];

    // Left boundary (0% of screen)
    guides.push({
      percent: 0,
      label: 'A0 (Low Bound)',
      color: 'border-rose-500/40 text-rose-300 bg-rose-500/10'
    });

    // Right boundary (100% of screen)
    guides.push({
      percent: 100,
      label: 'C8 (High Bound)',
      color: 'border-rose-500/40 text-rose-300 bg-rose-500/10'
    });

    // C octaves
    const cNotes = [
      { midi: 24, label: 'C1' },
      { midi: 36, label: 'C2' },
      { midi: 48, label: 'C3' },
      { midi: 60, label: 'C4 (Middle C)' },
      { midi: 72, label: 'C5' },
      { midi: 84, label: 'C6' },
      { midi: 96, label: 'C7' }
    ];

    for (const note of cNotes) {
      const mesh = this.pianoKeys[note.midi];
      if (mesh) {
        const x = mesh.position.x;
        // Map x from [-2.0, 2.0] to [0, 100] percent
        const percent = ((x + 2.0) / 4.0) * 100;
        
        // Let's distinguish Middle C with a slightly brighter look
        const color = note.midi === 60 
          ? 'border-emerald-400/40 text-emerald-300 bg-emerald-500/15 font-bold shadow-emerald-500/20' 
          : 'border-slate-500/20 text-slate-400 bg-slate-500/5';

        guides.push({
          percent,
          label: note.label,
          color
        });
      }
    }

    // Sort by percentage so they are rendered in sequence
    return guides.sort((a, b) => a.percent - b.percent);
  }

  onKeyPointerDown(event: PointerEvent, midi: number, name: string) {
    const el = event.target as HTMLElement;
    el.setPointerCapture(event.pointerId); 
    this.activePointers.set(event.pointerId, midi);
    this.playNote(midi, name);
  }

  onKeyPointerUp(event: PointerEvent) {
    const el = event.target as HTMLElement;
    if (el.hasPointerCapture(event.pointerId)) {
      el.releasePointerCapture(event.pointerId);
    }
    const midi = this.activePointers.get(event.pointerId);
    if (midi !== undefined) {
      const name = this.virtualKeys().find(k => k.midi === midi)?.name;
      if (name) this.stopNote(midi, name);
      this.activePointers.delete(event.pointerId);
    }
  }

  onKeyPointerEnter(event: PointerEvent, midi: number, name: string) {
    if (event.buttons > 0 && this.activePointers.has(event.pointerId)) {
      const oldMidi = this.activePointers.get(event.pointerId)!;
      if (oldMidi !== midi) {
        const oldName = this.virtualKeys().find(k => k.midi === oldMidi)?.name;
        if (oldName) this.stopNote(oldMidi, oldName);
        this.activePointers.set(event.pointerId, midi);
        this.playNote(midi, name);
      }
    }
  }

  private playNote(midi: number, name: string) {
    Tone.start();
    this.synth.triggerAttack(name);
    this.setKeyActive(midi, true);
  }

  private stopNote(midi: number, name: string) {
    this.synth.triggerRelease(name);
    this.setKeyActive(midi, false);
  }

  private setKeyActive(midi: number, active: boolean) {
    this.virtualKeys.update(keys => {
      const keyIndex = keys.findIndex(k => k.midi === midi);
      if (keyIndex > -1) {
        const newKeys = [...keys];
        newKeys[keyIndex] = { ...newKeys[keyIndex], active };
        return newKeys;
      }
      return keys;
    });
  }

  ngOnDestroy() {
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
    }
    this.renderer?.dispose();
  }

  async onMidiFileSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    if (!input.files || input.files.length === 0) return;
    const file = input.files[0];
    this.midiTrackName.set(file.name);

    const arrayBuffer = await file.arrayBuffer();
    const midi = new Midi(arrayBuffer);
    this.midiData = midi;
    this.midiLoaded.set(true);

    // Clear existing notes
    this.fallingNotes.forEach(note => this.scene.remove(note.mesh));
    this.fallingNotes = [];

    // Combine all tracks and create meshes for notes
    midi.tracks.forEach((track: ToneTrack) => {
      track.notes.forEach((note: ToneNote) => {
        // midi is typically 21 to 108 for piano keys (88 keys)
        if (note.midi >= 21 && note.midi <= 108) {
          const isBlack = [1, 3, 6, 8, 10].includes(note.midi % 12);
          const width = 4.0 / 52; 
          const noteWidth = isBlack ? width * 0.5 : width * 0.8;
          const geometry = new THREE.BoxGeometry(noteWidth, note.duration * 2, 0.05); 
          
          // Different colors for black vs white notes (optional but nice)
          const material = new THREE.MeshBasicMaterial({ 
            color: isBlack ? 0x60a5fa : 0x3b82f6, // blue-400 vs blue-500
            transparent: true, 
            opacity: 0.8 
          });
          
          const mesh = new THREE.Mesh(geometry, material);
          
          mesh.position.set(0, -100, 0); // Hide initially
          this.scene.add(mesh);
          
          this.fallingNotes.push({
            mesh,
            midi: note.midi,
            time: note.time,
            duration: note.duration
          });
        }
      });
    });

    this.stopMidi();
    this.togglePlay();
    
    input.value = '';
  }

  async togglePlay() {
    await Tone.start();
    if (this.isMidiPlaying()) {
      // Pause
      this.isMidiPlaying.set(false);
      this.currentPauseTime = (performance.now() / 1000) - this.midiStartTime;
      Tone.Transport.pause();
    } else {
      // Play
      this.isMidiPlaying.set(true);
      if (this.currentPauseTime === 0 && this.midiData) {
        this.midiStartTime = (performance.now() / 1000);
        this.scheduleToneNotes();
      } else {
        this.midiStartTime = (performance.now() / 1000) - this.currentPauseTime;
      }
      Tone.Transport.start();
    }
  }

  stopMidi() {
    this.isMidiPlaying.set(false);
    this.currentPauseTime = 0;
    Tone.Transport.stop();
    Tone.Transport.cancel();
    this.synth.releaseAll();
    
    // reset visuals
    this.fallingNotes.forEach(n => n.mesh.position.y = -100);
    this.virtualKeys.update(keys => keys.map(k => ({ ...k, active: false })));
  }

  private scheduleToneNotes() {
    Tone.Transport.cancel();
    this.midiData?.tracks.forEach((track: ToneTrack) => {
      track.notes.forEach((note: ToneNote) => {
        Tone.Transport.schedule((time) => {
          this.synth.triggerAttackRelease(note.name, note.duration, time, note.velocity);
          
          // Sync visual keyboard using Tone.Draw
          Tone.Draw.schedule(() => {
            this.setKeyActive(note.midi, true);
          }, time);
          
          Tone.Draw.schedule(() => {
            this.setKeyActive(note.midi, false);
          }, time + note.duration);

        }, note.time);
      });
    });
  }

  private initThreeJs() {
    const container = this.threeContainer.nativeElement;
    
    this.scene = new THREE.Scene();
    
    // Set up camera to perfectly align 4.0 width with the screen width
    const aspect = container.clientWidth / container.clientHeight;
    const fov = 2 * Math.atan(1 / aspect) * (180 / Math.PI);
    this.camera = new THREE.PerspectiveCamera(fov, aspect, 0.1, 100);
    this.camera.position.set(0, 0, 2);

    // Set up renderer
    this.renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.setPixelRatio(window.devicePixelRatio);
    container.appendChild(this.renderer.domElement);

    // Create Piano Keys (bounding box representation)
    const keyWidth = 4.0 / 52;
    const keyHeight = 0.4;
    const startX = -2.0 + (keyWidth / 2);
    const pianoY = -1.2; // Place at the bottom of the view

    const whiteKeyGeo = new THREE.BoxGeometry(keyWidth * 0.9, keyHeight, 0.1);
    const blackKeyGeo = new THREE.BoxGeometry(keyWidth * 0.6, keyHeight * 0.6, 0.15);
    const whiteKeyMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.15 });
    const blackKeyMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.3 });

    let whiteKeyIndex = 0;
    for (let i = 21; i <= 108; i++) {
      const isBlack = [1, 3, 6, 8, 10].includes(i % 12);
      let mesh: THREE.Mesh;
      
      if (isBlack) {
        mesh = new THREE.Mesh(blackKeyGeo, blackKeyMat);
        // Position between the previous and next white key, slightly raised
        mesh.position.set(startX + (whiteKeyIndex - 0.5) * keyWidth, pianoY + keyHeight * 0.2, 0.05);
      } else {
        mesh = new THREE.Mesh(whiteKeyGeo, whiteKeyMat);
        mesh.position.set(startX + whiteKeyIndex * keyWidth, pianoY, 0);
        
        whiteKeyIndex++;
      }
      mesh.visible = false; // Hide 3D keys, use HTML keyboard
      this.scene.add(mesh);
      this.pianoKeys[i] = mesh; // store by midi note number
    }

    // Add boundaries (dots at either side of the piano) - hide them too
    const boundaryGeo = new THREE.SphereGeometry(0.04, 16, 16);
    const boundaryMat = new THREE.MeshBasicMaterial({ color: 0xf43f5e }); // rose-500
    const leftBound = new THREE.Mesh(boundaryGeo, boundaryMat);
    leftBound.position.set(-2.0, pianoY, 0);
    leftBound.visible = false;
    this.scene.add(leftBound);
    const rightBound = new THREE.Mesh(boundaryGeo, boundaryMat);
    rightBound.position.set(2.0, pianoY, 0);
    rightBound.visible = false;
    this.scene.add(rightBound);

    // Create 21 spheres for landmarks for up to 2 hands (Left = Violet, Right = Emerald)
    const geometry = new THREE.SphereGeometry(0.02, 16, 16);
    const colors = [0x8b5cf6, 0x10b981]; // Left Hand (Violet), Right Hand (Emerald)

    for (let h = 0; h < 2; h++) {
      const material = new THREE.MeshBasicMaterial({ color: colors[h] });
      for (let i = 0; i < 21; i++) {
        const sphere = new THREE.Mesh(geometry, material);
        sphere.position.set(0, 0, -10); // hidden initially
        this.scene.add(sphere);
        this.landmarksMeshes[h].push(sphere);
      }
    }

    // MediaPipe Hand Connections
    const connections = [
      [0, 1], [1, 2], [2, 3], [3, 4], // thumb
      [0, 5], [5, 6], [6, 7], [7, 8], // index
      [5, 9], [9, 10], [10, 11], [11, 12], // middle
      [9, 13], [13, 14], [14, 15], [15, 16], // ring
      [13, 17], [0, 17], [17, 18], [18, 19], [19, 20] // pinky
    ];

    for (let h = 0; h < 2; h++) {
      const lineMaterial = new THREE.LineBasicMaterial({ color: colors[h], transparent: true, opacity: 0.4 });
      for (const connection of connections) {
        const lineGeometry = new THREE.BufferGeometry();
        lineGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
        const line = new THREE.Line(lineGeometry, lineMaterial);
        this.scene.add(line);
        this.skeletonLinesList[h].push({ line, c1: connection[0], c2: connection[1] });
      }
    }

    // Handle resize
    const resizeObserver = new ResizeObserver(() => {
      const aspect = container.clientWidth / container.clientHeight;
      this.camera.aspect = aspect;
      this.camera.fov = 2 * Math.atan(1 / aspect) * (180 / Math.PI);
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(container.clientWidth, container.clientHeight);
    });
    resizeObserver.observe(container);
  }

  private animate = () => {
    this.animationFrameId = requestAnimationFrame(this.animate);
    const now = performance.now() / 1000;

    const container = this.threeContainer?.nativeElement;
    if (!container) return;

    const aspect = container.clientWidth / container.clientHeight;
    const visibleHeight = 4.0 / aspect;
    const keyboardHeightPx = 112; // h-28 = 112px
    const keyboardRatio = keyboardHeightPx / container.clientHeight;
    const pianoY = (-visibleHeight / 2) + (keyboardRatio * visibleHeight);

    // Update Three.js MIDI Waterfall
    if (this.isMidiPlaying()) {
      const elapsedTime = now - this.midiStartTime;
      // Standardise fallSpeed so notes take a fixed time (e.g. 2 seconds) to cross the screen
      const fallSpeed = visibleHeight / 2.0; 
      
      this.fallingNotes.forEach(note => {
        // Calculate Y position based on time difference
        const timeUntilHit = note.time - elapsedTime;
        
        // If it's too far in the future or way past, hide it
        if (timeUntilHit > 5 || timeUntilHit < -note.duration - 1) {
          note.mesh.position.y = -100;
          return;
        }

        const targetKey = this.pianoKeys[note.midi];
        if (targetKey) {
          // Center of the note block
          const yPos = pianoY + (timeUntilHit * fallSpeed) + (note.duration * fallSpeed / 2);
          note.mesh.position.set(targetKey.position.x, yPos, 0);
          
          // Scale the mesh so its physical height matches its duration * fallSpeed
          note.mesh.scale.y = fallSpeed / 2.0;
          
          // Simple visual feedback when note hits the key
          if (timeUntilHit <= 0 && timeUntilHit >= -note.duration) {
            (targetKey.material as THREE.Material).opacity = 0.8;
          } else {
            // Reset opacity
            const isBlack = [1, 3, 6, 8, 10].includes(note.midi % 12);
            (targetKey.material as THREE.Material).opacity = isBlack ? 0.3 : 0.15;
          }
        }
      });
    }

    // Update Hand Tracking
    const payload = this.telemetry.data();
    const handLandmarksList: ({ x: number; y: number; z: number }[] | null)[] = [null, null];
    const isHandActive = [false, false];

    // 1. Process physical hands stream if available
    if (payload && payload.hands.length > 0) {
      payload.hands.forEach(hand => {
        const lm = hand.landmarks;
        if (lm && lm.length >= 63) {
          const isLeft = hand.handedness.toLowerCase().includes('left');
          const hIndex = isLeft ? 1 : 0; // Swapped: Left maps to Index 1, Right maps to Index 0
          
          isHandActive[hIndex] = true;
          const landmarks: { x: number; y: number; z: number }[] = [];
          for (let i = 0; i < 21; i++) {
            landmarks.push({
              x: (lm[i * 3] - 0.5) * 1.5,
              y: -(lm[i * 3 + 1] - 0.5) * 1.5,
              z: -lm[i * 3 + 2] * 1.5
            });
          }
          handLandmarksList[hIndex] = landmarks;
        }
      });
    } 
    
    // 3. Render and handle collision for both hands
    for (let hIndex = 0; hIndex < 2; hIndex++) {
      const isActive = isHandActive[hIndex];
      const landmarks = handLandmarksList[hIndex];

      if (isActive && landmarks) {
        // Update spheres
        for (let i = 0; i < 21; i++) {
          this.landmarksMeshes[hIndex][i].position.set(landmarks[i].x, landmarks[i].y, landmarks[i].z);
        }
        
        // Update lines
        for (const item of this.skeletonLinesList[hIndex]) {
          const p1 = this.landmarksMeshes[hIndex][item.c1].position;
          const p2 = this.landmarksMeshes[hIndex][item.c2].position;
          const posAttribute = item.line.geometry.getAttribute('position');
          posAttribute.setXYZ(0, p1.x, p1.y, p1.z);
          posAttribute.setXYZ(1, p2.x, p2.y, p2.z);
          posAttribute.needsUpdate = true;
        }

        // Check key collisions
        this.checkHandPianoCollisions(hIndex, landmarks, pianoY);
      } else {
        // Hide landmarks
        for (let i = 0; i < 21; i++) {
          this.landmarksMeshes[hIndex][i].position.set(0, 0, -100);
        }
        for (const item of this.skeletonLinesList[hIndex]) {
          const posAttribute = item.line.geometry.getAttribute('position');
          posAttribute.setXYZ(0, 0, 0, -100);
          posAttribute.setXYZ(1, 0, 0, -100);
          posAttribute.needsUpdate = true;
        }

        // Clear collision notes for this hand
        this.clearHandTriggeredNotesForIndex(hIndex);
      }
    }

    this.renderer.render(this.scene, this.camera);
  };

  private checkHandPianoCollisions(h: number, landmarks: { x: number; y: number; z: number }[], pianoY: number) {
    const keyWidth = 4.0 / 52;
    const currentlyPressedMidiNotes = new Set<number>();
    
    // Fingertips: Thumb (4), Index (8), Middle (12), Ring (16), Pinky (20)
    const fingertips = [4, 8, 12, 16, 20];

    for (const tipIndex of fingertips) {
      const tip = landmarks[tipIndex];
      
      // Find which piano key this fingertip collides with
      for (let k = 21; k <= 108; k++) {
        const keyMesh = this.pianoKeys[k];
        if (!keyMesh) continue;

        const isBlack = [1, 3, 6, 8, 10].includes(k % 12);
        const halfWidth = isBlack ? (keyWidth * 0.6 * 0.5) : (keyWidth * 0.9 * 0.5);
        const dx = Math.abs(tip.x - keyMesh.position.x);

        if (dx <= halfWidth) {
          // Trigger if fingertip's Y goes near or below pianoY + 0.12 (indicating contact)
          if (tip.y <= pianoY + 0.12 && tip.y >= pianoY - 0.25) {
            currentlyPressedMidiNotes.add(k);
            break; 
          }
        }
      }
    }

    const notes = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

    // Release notes no longer pressed by this hand
    this.handTriggeredMidiNotes[h].forEach(midi => {
      if (!currentlyPressedMidiNotes.has(midi)) {
        // Only turn off if the other hand is not playing it
        const otherHand = h === 0 ? 1 : 0;
        if (!this.handTriggeredMidiNotes[otherHand].has(midi)) {
          const octave = Math.floor((midi / 12) - 1);
          const noteName = notes[midi % 12];
          const fullName = `${noteName}${octave}`;
          this.stopNote(midi, fullName);
        }
      }
    });

    // Press new notes
    currentlyPressedMidiNotes.forEach(midi => {
      if (!this.handTriggeredMidiNotes[h].has(midi)) {
        const octave = Math.floor((midi / 12) - 1);
        const noteName = notes[midi % 12];
        const fullName = `${noteName}${octave}`;
        this.playNote(midi, fullName);
      }
    });

    this.handTriggeredMidiNotes[h] = currentlyPressedMidiNotes;
  }

  private clearHandTriggeredNotesForIndex(h: number) {
    if (this.handTriggeredMidiNotes[h].size === 0) return;
    const notes = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    this.handTriggeredMidiNotes[h].forEach(midi => {
      const otherHand = h === 0 ? 1 : 0;
      if (!this.handTriggeredMidiNotes[otherHand].has(midi)) {
        const octave = Math.floor((midi / 12) - 1);
        const noteName = notes[midi % 12];
        const fullName = `${noteName}${octave}`;
        this.stopNote(midi, fullName);
      }
    });
    this.handTriggeredMidiNotes[h].clear();
  }

  private clearAllHandTriggeredNotes() {
    this.clearHandTriggeredNotesForIndex(0);
    this.clearHandTriggeredNotesForIndex(1);
  }
}

