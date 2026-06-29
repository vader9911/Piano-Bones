import { ChangeDetectionStrategy, Component, ElementRef, ViewChild, AfterViewInit, OnDestroy, computed, inject } from '@angular/core';
import { TelemetryService } from './telemetry.service';
import * as THREE from 'three';
import { Chart, LineController, LineElement, PointElement, LinearScale, CategoryScale } from 'chart.js';

Chart.register(LineController, LineElement, PointElement, LinearScale, CategoryScale);

interface SkeletonLine {
  line: THREE.Line;
  c1: number;
  c2: number;
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
  @ViewChild('chartCanvas') chartCanvas!: ElementRef<HTMLCanvasElement>;

  // Computed signals for template
  wristHeightCm = computed(() => this.telemetry.metrics().wristHeightCm.toFixed(2));
  mcpFlexionDeg = computed(() => this.telemetry.metrics().mcpFlexionDeg.toFixed(1));
  jitterMs = computed(() => this.telemetry.metrics().jitterMs.toFixed(2));
  connected = computed(() => this.telemetry.connected());
  logs = computed(() => this.telemetry.logs().slice(0, 5));

  // Three.js state
  private scene!: THREE.Scene;
  private camera!: THREE.PerspectiveCamera;
  private renderer!: THREE.WebGLRenderer;
  private animationFrameId?: number;
  
  // A simple representation of 21 landmarks
  private landmarksMesh: THREE.Mesh[] = [];
  // Lines connecting the landmarks (MediaPipe skeleton)
  private skeletonLines: SkeletonLine[] = [];
  
  private chart!: Chart;
  private chartData: number[] = [];
  private chartLabels: string[] = [];

  ngAfterViewInit() {
    if (typeof window === 'undefined') return;
    this.initThreeJs();
    this.initChart();
    this.animate();
  }

  ngOnDestroy() {
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
    }
    this.renderer?.dispose();
    this.chart?.destroy();
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

    // Create 21 spheres for landmarks
    const geometry = new THREE.SphereGeometry(0.03, 16, 16);
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

    const lineMaterial = new THREE.LineBasicMaterial({ color: 0x10b981, transparent: true, opacity: 0.6 });
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

  private initChart() {
    const ctx = this.chartCanvas.nativeElement.getContext('2d');
    if (!ctx) return;

    for (let i = 0; i < 60; i++) {
      this.chartLabels.push('');
      this.chartData.push(0);
    }

    this.chart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: this.chartLabels,
        datasets: [{
          label: 'Wrist Height',
          data: this.chartData,
          borderColor: '#10b981',
          borderWidth: 1.5,
          tension: 0.4,
          pointRadius: 0
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        scales: {
          x: { display: false },
          y: { 
            display: false,
            min: 0,
            max: 30
          }
        },
        plugins: {
          legend: { display: false }
        }
      }
    });
  }

  private animate = () => {
    this.animationFrameId = requestAnimationFrame(this.animate);

    // Update Three.js
    const payload = this.telemetry.data();
    if (payload && payload.hands.length > 0) {
      const lm = payload.hands[0].landmarks;
      if (lm && lm.length >= 63) {
        // Update spheres
        for (let i = 0; i < 21; i++) {
          // MediaPipe coords: X, Y [0, 1] from top-left, Z relative.
          // Map to Three.js space: center is 0,0, Y is up.
          const x = (lm[i * 3] - 0.5) * 2.5; 
          const y = -(lm[i * 3 + 1] - 0.5) * 2.5;
          const z = -lm[i * 3 + 2] * 2.5;
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

    // Update Chart roughly every frame or slightly less
    const currentHeight = this.telemetry.metrics().wristHeightCm;
    this.chartData.push(currentHeight);
    this.chartData.shift();
    if (this.chart) {
      this.chart.update();
    }
  }
}

