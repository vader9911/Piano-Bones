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
  wristHeightCm = computed(() => this.telemetry.metrics().wristHeightCm.toFixed(2));
  connected = computed(() => this.telemetry.connected());
  logs = computed(() => this.telemetry.logs().slice(0, 3)); // Only show top 3 logs
  midiTrackName = signal<string>('None Loaded');

  // Three.js state
  private scene!: THREE.Scene;
  private camera!: THREE.PerspectiveCamera;
  private renderer!: THREE.WebGLRenderer;
  private animationFrameId?: number;
  
  // A simple representation of 21 landmarks
  private landmarksMesh: THREE.Mesh[] = [];
  // Lines connecting the landmarks (MediaPipe skeleton)
  private skeletonLines: SkeletonLine[] = [];

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

  ngAfterViewInit() {
    if (typeof window === 'undefined') return;
    this.synth = new Tone.PolySynth(Tone.Synth).toDestination();
    this.initVirtualKeyboard();
    this.initThreeJs();
    this.animate();
  }

  private initVirtualKeyboard() {
    const keys = [];
    const notes = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    // We'll use 61 keys (from C2 midi 36 to C7 midi 96) for a nicer view, or 88 keys.
    // Let's do a 61-key layout (36 to 96) which is 5 octaves.
    for (let i = 36; i <= 96; i++) {
      const octave = Math.floor(i / 12) - 1;
      const noteName = notes[i % 12];
      const isBlack = noteName.includes('#');
      keys.push({ midi: i, name: `${noteName}${octave}`, isBlack, active: false });
    }
    this.virtualKeys.set(keys);
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
          const width = 4.0 / 52; 
          const geometry = new THREE.BoxGeometry(width * 0.8, note.duration * 2, 0.05); 
          const mesh = new THREE.Mesh(geometry, this.noteMaterial);
          
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
    
    // Set up camera
    this.camera = new THREE.PerspectiveCamera(50, container.clientWidth / container.clientHeight, 0.1, 100);
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
    const outlineMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.3 });

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
        
        // Add outline to white keys for better visibility
        const edges = new THREE.EdgesGeometry(whiteKeyGeo);
        const line = new THREE.LineSegments(edges, outlineMat);
        mesh.add(line);
        
        whiteKeyIndex++;
      }
      this.scene.add(mesh);
      this.pianoKeys[i] = mesh; // store by midi note number
    }

    // Add boundaries (dots at either side of the piano)
    const boundaryGeo = new THREE.SphereGeometry(0.04, 16, 16);
    const boundaryMat = new THREE.MeshBasicMaterial({ color: 0xf43f5e }); // rose-500
    const leftBound = new THREE.Mesh(boundaryGeo, boundaryMat);
    leftBound.position.set(-2.0, pianoY, 0);
    this.scene.add(leftBound);
    const rightBound = new THREE.Mesh(boundaryGeo, boundaryMat);
    rightBound.position.set(2.0, pianoY, 0);
    this.scene.add(rightBound);

    // Create 21 spheres for landmarks
    const geometry = new THREE.SphereGeometry(0.02, 16, 16);
    const material = new THREE.MeshBasicMaterial({ color: 0x10b981 }); // emerald-500

    for (let i = 0; i < 21; i++) {
      const sphere = new THREE.Mesh(geometry, material);
      sphere.position.set(0, 0, -10); // hidden initially
      this.scene.add(sphere);
      this.landmarksMesh.push(sphere);
    }

    // MediaPipe Hand Connections
    const connections = [
      [0, 1], [1, 2], [2, 3], [3, 4], // thumb
      [0, 5], [5, 6], [6, 7], [7, 8], // index
      [5, 9], [9, 10], [10, 11], [11, 12], // middle
      [9, 13], [13, 14], [14, 15], [15, 16], // ring
      [13, 17], [0, 17], [17, 18], [18, 19], [19, 20] // pinky
    ];

    const lineMaterial = new THREE.LineBasicMaterial({ color: 0x10b981, transparent: true, opacity: 0.4 });
    for (const connection of connections) {
      const lineGeometry = new THREE.BufferGeometry();
      lineGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
      const line = new THREE.Line(lineGeometry, lineMaterial);
      this.scene.add(line);
      this.skeletonLines.push({ line, c1: connection[0], c2: connection[1] });
    }

    // Handle resize
    const resizeObserver = new ResizeObserver(() => {
      this.camera.aspect = container.clientWidth / container.clientHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(container.clientWidth, container.clientHeight);
    });
    resizeObserver.observe(container);
  }

  private animate = () => {
    this.animationFrameId = requestAnimationFrame(this.animate);
    const now = performance.now() / 1000;

    // Update Three.js MIDI Waterfall
    if (this.isMidiPlaying()) {
      const elapsedTime = now - this.midiStartTime;
      const fallSpeed = 2.0; // units per second
      const pianoY = -1.2;

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
          note.mesh.position.set(targetKey.position.x, yPos, targetKey.position.z - 0.05);
          
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
    if (payload && payload.hands.length > 0) {
      const lm = payload.hands[0].landmarks;
      if (lm && lm.length >= 63) {
        // Update spheres
        for (let i = 0; i < 21; i++) {
          // MediaPipe coords: X, Y [0, 1] from top-left, Z relative.
          // Map to Three.js space: center is 0,0, Y is up.
          // Reduced scale from 3.5 to 1.5 to make hand smaller in view
          const x = (lm[i * 3] - 0.5) * 1.5; 
          const y = -(lm[i * 3 + 1] - 0.5) * 1.5;
          const z = -lm[i * 3 + 2] * 1.5;
          this.landmarksMesh[i].position.set(x, y, z);
        }
        
        // Update lines
        for (const item of this.skeletonLines) {
          const p1 = this.landmarksMesh[item.c1].position;
          const p2 = this.landmarksMesh[item.c2].position;
          const posAttribute = item.line.geometry.getAttribute('position');
          posAttribute.setXYZ(0, p1.x, p1.y, p1.z);
          posAttribute.setXYZ(1, p2.x, p2.y, p2.z);
          posAttribute.needsUpdate = true;
        }
      }
    } else {
      // Hide if no hands
      for (let i = 0; i < 21; i++) {
        this.landmarksMesh[i].position.set(0, 0, -100);
      }
      for (const item of this.skeletonLines) {
        const posAttribute = item.line.geometry.getAttribute('position');
        posAttribute.setXYZ(0, 0, 0, -100);
        posAttribute.setXYZ(1, 0, 0, -100);
        posAttribute.needsUpdate = true;
      }
    }

    this.renderer.render(this.scene, this.camera);
  }
}

