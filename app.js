// State Management
const state = {
  pages: [], // Array of { id, originalSrc, croppedSrc, enhancedSrc, corners, rotation, mode: 'scan'|'photo', brightness: 220 }
  currentPageIndex: -1,
  activeView: 'gallery',
  isDraggingCorner: -1,
  cropCorners: [] // [p0, p1, p2, p3] representing corners in source image space
};

// UI Selectors
const views = {
  gallery: document.getElementById('view-gallery'),
  crop: document.getElementById('view-crop'),
  enhance: document.getElementById('view-enhance')
};

const pagesGrid = document.getElementById('pages-grid');
const emptyState = document.getElementById('empty-state');
const loadingOverlay = document.getElementById('loading-overlay');
const loadingText = document.getElementById('loading-text');

const cropCanvas = document.getElementById('crop-canvas');
const cropCtx = cropCanvas.getContext('2d');
const enhancePreview = document.getElementById('enhance-preview');

// Configuration
const CORNER_HANDLE_RADIUS = 15;
const CORNER_HANDLE_TOUCH_RADIUS = 30;

// Register Service Worker
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js')
      .then(reg => console.log('Service Worker registered.'))
      .catch(err => console.log('Service worker registration failed:', err));
  });
}

// Show/Hide Loading Overlay
function showLoading(text = 'Processing...') {
  loadingText.textContent = text;
  loadingOverlay.classList.add('active');
}

function hideLoading() {
  loadingOverlay.classList.remove('active');
}

// Switch between views
function switchView(viewName) {
  state.activeView = viewName;
  Object.keys(views).forEach(key => {
    if (key === viewName) {
      views[key].classList.add('active');
    } else {
      views[key].classList.remove('active');
    }
  });
}

// Image Loader Helper
function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

// --- Image processing mathematics ---

// Helper to project/warp a quadrilateral using Bilinear Interpolation
// This maps source quadrilateral corners (p0, p1, p2, p3) onto a flat destination rectangle of width W, height H
function bilinearWarp(srcImg, corners, destWidth, destHeight) {
  const srcCanvas = document.createElement('canvas');
  srcCanvas.width = srcImg.naturalWidth;
  srcCanvas.height = srcImg.naturalHeight;
  const srcCtx = srcCanvas.getContext('2d');
  srcCtx.drawImage(srcImg, 0, 0);
  const srcData = srcCtx.getImageData(0, 0, srcCanvas.width, srcCanvas.height);
  const srcPixels = srcData.data;
  const sw = srcCanvas.width;
  const sh = srcCanvas.height;

  const destCanvas = document.createElement('canvas');
  destCanvas.width = destWidth;
  destCanvas.height = destHeight;
  const destCtx = destCanvas.getContext('2d');
  const destData = destCtx.createImageData(destWidth, destHeight);
  const destPixels = destData.data;

  const [p0, p1, p2, p3] = corners; // TL, TR, BR, BL

  for (let y = 0; y < destHeight; y++) {
    const v = y / destHeight;
    for (let x = 0; x < destWidth; x++) {
      const u = x / destWidth;

      // Bilinear interpolation formula for mapping destination coordinates (u, v) to source coordinates (sx, sy)
      const sx = (1 - u) * (1 - v) * p0.x + u * (1 - v) * p1.x + u * v * p2.x + (1 - u) * v * p3.x;
      const sy = (1 - u) * (1 - v) * p0.y + u * (1 - v) * p1.y + u * v * p2.y + (1 - u) * v * p3.y;

      // Nearest Neighbor mapping back to source pixels (bounds safe)
      const px = Math.min(sw - 1, Math.max(0, Math.round(sx)));
      const py = Math.min(sh - 1, Math.max(0, Math.round(sy)));

      const destIdx = (y * destWidth + x) * 4;
      const srcIdx = (py * sw + px) * 4;

      destPixels[destIdx] = srcPixels[srcIdx];
      destPixels[destIdx + 1] = srcPixels[srcIdx + 1];
      destPixels[destIdx + 2] = srcPixels[srcIdx + 2];
      destPixels[destIdx + 3] = srcPixels[srcIdx + 3];
    }
  }

  destCtx.putImageData(destData, 0, 0);
  return destCanvas.toDataURL('image/jpeg', 0.95);
}

function flatfieldEnhance(img, whitePoint, blackPoint) {
  const canvas = document.createElement('canvas');
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);

  const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const pixels = imgData.data;

  // Grid background estimation (16x16 blocks)
  const cols = 16;
  const rows = 16;
  const bw = Math.ceil(w / cols);
  const bh = Math.ceil(h / rows);
  const bgGrid = new Float32Array(cols * rows * 3);

  // 1. Find local maximum (paper color) in each grid cell
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let maxR = 0, maxG = 0, maxB = 0;
      const yStart = r * bh;
      const yEnd = Math.min(h, yStart + bh);
      const xStart = c * bw;
      const xEnd = Math.min(w, xStart + bw);

      for (let y = yStart; y < yEnd; y += 4) {
        for (let x = xStart; x < xEnd; x += 4) {
          const idx = (y * w + x) * 4;
          if (pixels[idx] > maxR) maxR = pixels[idx];
          if (pixels[idx + 1] > maxG) maxG = pixels[idx + 1];
          if (pixels[idx + 2] > maxB) maxB = pixels[idx + 2];
        }
      }

      const gridIdx = (r * cols + c) * 3;
      bgGrid[gridIdx] = maxR || 255;
      bgGrid[gridIdx + 1] = maxG || 255;
      bgGrid[gridIdx + 2] = maxB || 255;
    }
  }

  // 2. Smooth the background grid using a basic 3x3 box filter
  const bgGridSmoothed = new Float32Array(bgGrid.length);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let sumR = 0, sumG = 0, sumB = 0, count = 0;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const nr = r + dr;
          const nc = c + dc;
          if (nr >= 0 && nr < rows && nc >= 0 && nc < cols) {
            const idx = (nr * cols + nc) * 3;
            sumR += bgGrid[idx];
            sumG += bgGrid[idx + 1];
            sumB += bgGrid[idx + 2];
            count++;
          }
        }
      }
      const outIdx = (r * cols + c) * 3;
      bgGridSmoothed[outIdx] = sumR / count;
      bgGridSmoothed[outIdx + 1] = sumG / count;
      bgGridSmoothed[outIdx + 2] = sumB / count;
    }
  }

  // 3. Apply Bilinear Interpolation of background light map, Flatfield division, and Levels stretching
  for (let y = 0; y < h; y++) {
    const v = y / bh;
    const r0 = Math.min(rows - 1, Math.floor(v));
    const r1 = Math.min(rows - 1, r0 + 1);
    const tv = v - r0;

    for (let x = 0; x < w; x++) {
      const u = x / bw;
      const c0 = Math.min(cols - 1, Math.floor(u));
      const c1 = Math.min(cols - 1, c0 + 1);
      const tu = u - c0;

      const idx00 = (r0 * cols + c0) * 3;
      const idx01 = (r0 * cols + c1) * 3;
      const idx10 = (r1 * cols + c0) * 3;
      const idx11 = (r1 * cols + c1) * 3;

      // Bilinear background calculation for current pixel
      const bgR = (1 - tu) * (1 - tv) * bgGridSmoothed[idx00] + tu * (1 - tv) * bgGridSmoothed[idx01] + (1 - tu) * tv * bgGridSmoothed[idx10] + tu * tv * bgGridSmoothed[idx11];
      const bgG = (1 - tu) * (1 - tv) * bgGridSmoothed[idx00+1] + tu * (1 - tv) * bgGridSmoothed[idx01+1] + (1 - tu) * tv * bgGridSmoothed[idx10+1] + tu * tv * bgGridSmoothed[idx11+1];
      const bgB = (1 - tu) * (1 - tv) * bgGridSmoothed[idx00+2] + tu * (1 - tv) * bgGridSmoothed[idx01+2] + (1 - tu) * tv * bgGridSmoothed[idx10+2] + tu * tv * bgGridSmoothed[idx11+2];

      const idx = (y * w + x) * 4;

      // Flat field division: Val = (Original / Background) * 255
      let valR = (pixels[idx] / (bgR || 1)) * 255;
      let valG = (pixels[idx + 1] / (bgG || 1)) * 255;
      let valB = (pixels[idx + 2] / (bgB || 1)) * 255;

      // Levels Stretch (removes background fluctuations/noise and eliminates dark outlines)
      valR = (valR - blackPoint) * (255 / (whitePoint - blackPoint));
      valG = (valG - blackPoint) * (255 / (whitePoint - blackPoint));
      valB = (valB - blackPoint) * (255 / (whitePoint - blackPoint));

      pixels[idx] = Math.min(255, Math.max(0, valR));
      pixels[idx + 1] = Math.min(255, Math.max(0, valG));
      pixels[idx + 2] = Math.min(255, Math.max(0, valB));
      // Alpha remains unchanged
    }
  }

  ctx.putImageData(imgData, 0, 0);
  return canvas.toDataURL('image/jpeg', 0.9);
}

// Auto-detect paper corners using color/brightness thresholding
function autoDetectPaperCorners(img) {
  const tempCanvas = document.createElement('canvas');
  const maxDim = 300; // Small size for fast parsing
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  const scale = maxDim / Math.max(w, h);
  tempCanvas.width = Math.round(w * scale);
  tempCanvas.height = Math.round(h * scale);
  
  const ctx = tempCanvas.getContext('2d');
  ctx.drawImage(img, 0, 0, tempCanvas.width, tempCanvas.height);
  
  const imgData = ctx.getImageData(0, 0, tempCanvas.width, tempCanvas.height);
  const pixels = imgData.data;
  const tw = tempCanvas.width;
  const th = tempCanvas.height;
  
  // 1. Compute brightness grid
  const totalPixels = tw * th;
  const brightnessGrid = new Uint8Array(totalPixels);
  for (let idx = 0; idx < totalPixels; idx++) {
    const pxIdx = idx * 4;
    brightnessGrid[idx] = Math.round((pixels[pxIdx] + pixels[pxIdx + 1] + pixels[pxIdx + 2]) / 3);
  }

  // 2. Compute Integral Image for fast local mean thresholding
  const integral = new Int32Array(totalPixels);
  for (let y = 0; y < th; y++) {
    let rowSum = 0;
    for (let x = 0; x < tw; x++) {
      const idx = y * tw + x;
      rowSum += brightnessGrid[idx];
      integral[idx] = rowSum + (y > 0 ? integral[idx - tw] : 0);
    }
  }

  // 3. Local Adaptive Thresholding (with 15% window size and 35 absolute floor)
  const winSize = Math.round(Math.max(tw, th) * 0.15);
  const r = Math.round(winSize / 2);
  const binaryGrid = new Uint8Array(totalPixels);
  
  for (let y = 0; y < th; y++) {
    const y0 = Math.max(0, y - r);
    const y1 = Math.min(th - 1, y + r);
    for (let x = 0; x < tw; x++) {
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(tw - 1, x + r);
      
      const count = (y1 - y0 + 1) * (x1 - x0 + 1);
      
      const i00 = (y0 > 0 && x0 > 0) ? integral[(y0 - 1) * tw + (x0 - 1)] : 0;
      const i01 = (y0 > 0) ? integral[(y0 - 1) * tw + x1] : 0;
      const i10 = (x0 > 0) ? integral[y1 * tw + (x0 - 1)] : 0;
      const i11 = integral[y1 * tw + x1];
      
      const sum = i11 - i01 - i10 + i00;
      const localAverage = sum / count;
      
      const idx = y * tw + x;
      const val = brightnessGrid[idx];
      // Adaptive mean - 12, with an absolute floor threshold of 35 to reject dark borders/tables
      binaryGrid[idx] = (val > (localAverage - 12) && val > 35) ? 1 : 0;
    }
  }

  // 4. BFS to find the largest connected component of foreground pixels
  const visited = new Uint8Array(totalPixels);
  let largestComponent = [];
  
  // Flat BFS queue to prevent stack size exceeded or dynamic allocations
  const queue = new Int32Array(totalPixels);
  
  for (let y = 0; y < th; y++) {
    for (let x = 0; x < tw; x++) {
      const idx = y * tw + x;
      if (binaryGrid[idx] === 1 && visited[idx] === 0) {
        let qHead = 0;
        let qTail = 0;
        queue[qTail++] = idx;
        visited[idx] = 1;
        
        while (qHead < qTail) {
          const currIdx = queue[qHead++];
          const cx = currIdx % tw;
          const cy = Math.floor(currIdx / tw);
          
          // Left
          if (cx > 0) {
            const nIdx = currIdx - 1;
            if (binaryGrid[nIdx] === 1 && visited[nIdx] === 0) {
              visited[nIdx] = 1;
              queue[qTail++] = nIdx;
            }
          }
          // Right
          if (cx < tw - 1) {
            const nIdx = currIdx + 1;
            if (binaryGrid[nIdx] === 1 && visited[nIdx] === 0) {
              visited[nIdx] = 1;
              queue[qTail++] = nIdx;
            }
          }
          // Up
          if (cy > 0) {
            const nIdx = currIdx - tw;
            if (binaryGrid[nIdx] === 1 && visited[nIdx] === 0) {
              visited[nIdx] = 1;
              queue[qTail++] = nIdx;
            }
          }
          // Down
          if (cy < th - 1) {
            const nIdx = currIdx + tw;
            if (binaryGrid[nIdx] === 1 && visited[nIdx] === 0) {
              visited[nIdx] = 1;
              queue[qTail++] = nIdx;
            }
          }
        }
        
        if (qTail > largestComponent.length) {
          largestComponent = new Int32Array(qTail);
          for (let i = 0; i < qTail; i++) {
            largestComponent[i] = queue[i];
          }
        }
      }
    }
  }

  // Fallback to default 5% margins if no component found or if the component is tiny
  const minArea = totalPixels * 0.015; 
  if (largestComponent.length < minArea) {
    const borderX = w * 0.05;
    const borderY = h * 0.05;
    return [
      { x: borderX, y: borderY },
      { x: w - borderX, y: borderY },
      { x: w - borderX, y: h - borderY },
      { x: borderX, y: h - borderY }
    ];
  }

  // 5. Find the 4 corners from the largest component using projection extrema
  let minTL = Infinity, maxTR = -Infinity, maxBR = -Infinity, minBL = Infinity;
  let ptTL = { x: 0, y: 0 };
  let ptTR = { x: tw, y: 0 };
  let ptBR = { x: tw, y: th };
  let ptBL = { x: 0, y: th };

  for (let i = 0; i < largestComponent.length; i++) {
    const idx = largestComponent[i];
    const x = idx % tw;
    const y = Math.floor(idx / tw);

    const valTL = x + y;
    const valTR = x - y;
    const valBR = x + y;
    const valBL = x - y;

    if (valTL < minTL) { minTL = valTL; ptTL = { x, y }; }
    if (valTR > maxTR) { maxTR = valTR; ptTR = { x, y }; }
    if (valBR > maxBR) { maxBR = valBR; ptBR = { x, y }; }
    if (valBL < minBL) { minBL = valBL; ptBL = { x, y }; }
  }

  // Scale back to original resolution coordinates
  const corners = [
    { x: ptTL.x / scale, y: ptTL.y / scale },
    { x: ptTR.x / scale, y: ptTR.y / scale },
    { x: ptBR.x / scale, y: ptBR.y / scale },
    { x: ptBL.x / scale, y: ptBL.y / scale }
  ];

  const cx = (corners[0].x + corners[1].x + corners[2].x + corners[3].x) / 4;
  const cy = (corners[0].y + corners[1].y + corners[2].y + corners[3].y) / 4;

  return corners.map(pt => {
    const dx = pt.x - cx;
    const dy = pt.y - cy;
    const dist = Math.hypot(dx, dy) || 1;
    const pad = Math.max(25, dist * 0.015);
    const ratio = Math.max(0, 1 - pad / dist);
    return {
      x: Math.min(w, Math.max(0, cx + dx * ratio)),
      y: Math.min(h, Math.max(0, cy + dy * ratio))
    };
  });
}

// --- Corner Handling & Cropping Interface ---

let cropEditorState = {
  img: null,
  scale: 1.0,
  offsetX: 0,
  offsetY: 0
};

function initCropEditor(imgSrc, rotation = 0, existingCorners = null) {
  showLoading('Loading image editor...');
  loadImage(imgSrc).then(img => {
    cropEditorState.img = img;
    
    const iw = img.naturalWidth;
    const ih = img.naturalHeight;

    // Load corners or detect them
    if (existingCorners && existingCorners.length === 4) {
      state.cropCorners = JSON.parse(JSON.stringify(existingCorners));
    } else {
      state.cropCorners = autoDetectPaperCorners(img);
    }

    renderCropCanvas();
    hideLoading();
    switchView('crop');
  }).catch(err => {
    hideLoading();
    alert('Error loading image into editor: ' + err.message);
  });
}

function renderCropCanvas() {
  const img = cropEditorState.img;
  if (!img) return;

  const wrapper = cropCanvas.parentElement;
  const maxW = wrapper.clientWidth;
  const maxH = wrapper.clientHeight;

  cropCanvas.width = maxW;
  cropCanvas.height = maxH;

  const iw = img.naturalWidth;
  const ih = img.naturalHeight;

  const scale = Math.min(maxW / iw, maxH / ih);
  const offsetX = (maxW - iw * scale) / 2;
  const offsetY = (maxH - ih * scale) / 2;

  cropEditorState.scale = scale;
  cropEditorState.offsetX = offsetX;
  cropEditorState.offsetY = offsetY;

  cropCtx.fillStyle = '#000';
  cropCtx.fillRect(0, 0, maxW, maxH);
  cropCtx.drawImage(img, offsetX, offsetY, iw * scale, ih * scale);

  // Overlay mask
  cropCtx.fillStyle = 'rgba(139, 92, 246, 0.15)';
  cropCtx.beginPath();
  const sc = state.cropCorners.map(pt => ({
    x: pt.x * scale + offsetX,
    y: pt.y * scale + offsetY
  }));
  cropCtx.moveTo(sc[0].x, sc[0].y);
  cropCtx.lineTo(sc[1].x, sc[1].y);
  cropCtx.lineTo(sc[2].x, sc[2].y);
  cropCtx.lineTo(sc[3].x, sc[3].y);
  cropCtx.closePath();
  cropCtx.fill();

  cropCtx.strokeStyle = '#8b5cf6';
  cropCtx.lineWidth = 3;
  cropCtx.stroke();

  // Draw handles
  sc.forEach((corner, idx) => {
    cropCtx.beginPath();
    cropCtx.arc(corner.x, corner.y, CORNER_HANDLE_RADIUS, 0, 2 * Math.PI);
    cropCtx.fillStyle = '#8b5cf6';
    cropCtx.fill();
    cropCtx.strokeStyle = 'white';
    cropCtx.lineWidth = 2.5;
    cropCtx.stroke();
    
    cropCtx.beginPath();
    cropCtx.arc(corner.x, corner.y, 4, 0, 2 * Math.PI);
    cropCtx.fillStyle = 'white';
    cropCtx.fill();
  });
}

function getCanvasTouchPos(e) {
  const rect = cropCanvas.getBoundingClientRect();
  const clientX = e.touches ? e.touches[0].clientX : e.clientX;
  const clientY = e.touches ? e.touches[0].clientY : e.clientY;
  return {
    x: clientX - rect.left,
    y: clientY - rect.top
  };
}

function handleStart(e) {
  const pos = getCanvasTouchPos(e);
  const scale = cropEditorState.scale;
  const offsetX = cropEditorState.offsetX;
  const offsetY = cropEditorState.offsetY;

  let activeIdx = -1;
  let minDist = CORNER_HANDLE_TOUCH_RADIUS;

  state.cropCorners.forEach((pt, idx) => {
    const cx = pt.x * scale + offsetX;
    const cy = pt.y * scale + offsetY;
    const dist = Math.hypot(pos.x - cx, pos.y - cy);
    if (dist < minDist) {
      minDist = dist;
      activeIdx = idx;
    }
  });

  if (activeIdx !== -1) {
    state.isDraggingCorner = activeIdx;
    e.preventDefault();
  }
}

function handleMove(e) {
  if (state.isDraggingCorner === -1) return;
  e.preventDefault();
  
  const pos = getCanvasTouchPos(e);
  const scale = cropEditorState.scale;
  const offsetX = cropEditorState.offsetX;
  const offsetY = cropEditorState.offsetY;

  const imgX = (pos.x - offsetX) / scale;
  const imgY = (pos.y - offsetY) / scale;

  const iw = cropEditorState.img.naturalWidth;
  const ih = cropEditorState.img.naturalHeight;

  state.cropCorners[state.isDraggingCorner] = {
    x: Math.min(iw, Math.max(0, imgX)),
    y: Math.min(ih, Math.max(0, imgY))
  };

  requestAnimationFrame(renderCropCanvas);
}

function handleEnd() {
  state.isDraggingCorner = -1;
}

cropCanvas.addEventListener('mousedown', handleStart);
cropCanvas.addEventListener('mousemove', handleMove);
window.addEventListener('mouseup', handleEnd);

cropCanvas.addEventListener('touchstart', handleStart, { passive: false });
cropCanvas.addEventListener('touchmove', handleMove, { passive: false });
window.addEventListener('touchend', handleEnd);

function rotateImageClockwise() {
  const img = cropEditorState.img;
  if (!img) return;
  
  showLoading('Rotating image...');
  
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalHeight;
  canvas.height = img.naturalWidth;
  const ctx = canvas.getContext('2d');
  
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate(90 * Math.PI / 180);
  ctx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);
  
  const rotatedSrc = canvas.toDataURL('image/jpeg', 0.95);
  
  loadImage(rotatedSrc).then(newImg => {
    cropEditorState.img = newImg;
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    state.cropCorners = state.cropCorners.map(pt => ({
      x: h - pt.y,
      y: pt.x
    }));
    
    const currentPage = state.pages[state.currentPageIndex];
    currentPage.originalSrc = rotatedSrc;
    currentPage.rotation = (currentPage.rotation + 90) % 360;
    
    renderCropCanvas();
    hideLoading();
  }).catch(err => {
    hideLoading();
    alert('Rotation failed: ' + err.message);
  });
}

document.getElementById('btn-crop-rotate').addEventListener('click', rotateImageClockwise);

document.getElementById('btn-crop-cancel').addEventListener('click', () => {
  switchView('gallery');
});

document.getElementById('btn-crop-apply').addEventListener('click', () => {
  const page = state.pages[state.currentPageIndex];
  page.corners = JSON.parse(JSON.stringify(state.cropCorners));
  
  showLoading('Warping document...');
  
  setTimeout(() => {
    try {
      const img = cropEditorState.img;
      const [p0, p1, p2, p3] = page.corners;
      const topWidth = Math.hypot(p1.x - p0.x, p1.y - p0.y);
      const bottomWidth = Math.hypot(p2.x - p3.x, p2.y - p3.y);
      const leftHeight = Math.hypot(p3.x - p0.x, p3.y - p0.y);
      const rightHeight = Math.hypot(p2.x - p1.x, p2.y - p1.y);
      
      const targetW = Math.round(Math.max(topWidth, bottomWidth));
      const targetH = Math.round(Math.max(leftHeight, rightHeight));
      
      const warpedSrc = bilinearWarp(img, page.corners, targetW, targetH);
      page.croppedSrc = warpedSrc;
      
      initEnhanceEditor(warpedSrc);
    } catch(err) {
      hideLoading();
      alert('Error warping page: ' + err.message);
    }
  }, 50);
});

// --- Enhance Preview Screen ---

let enhanceEditorState = {
  img: null,
  previewCanvas: null
};

function initEnhanceEditor(croppedSrc) {
  showLoading('Preparing enhance editor...');
  loadImage(croppedSrc).then(img => {
    enhanceEditorState.img = img;
    
    // Create downscaled preview canvas (max 800px)
    const maxDim = 800;
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    const scale = Math.min(maxDim / w, maxDim / h, 1.0);
    
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    
    enhanceEditorState.previewCanvas = canvas;
    
    const page = state.pages[state.currentPageIndex];
    
    const tabScan = document.getElementById('tab-scan');
    const tabPhoto = document.getElementById('tab-photo');
    const sliderBrightness = document.getElementById('slider-brightness');
    const labelBrightness = document.getElementById('label-brightness');
    
    if (page.mode === 'scan') {
      tabScan.classList.add('active');
      tabPhoto.classList.remove('active');
      document.getElementById('brightness-control').style.display = 'flex';
    } else {
      tabPhoto.classList.add('active');
      tabScan.classList.remove('active');
      document.getElementById('brightness-control').style.display = 'none';
    }
    
    sliderBrightness.value = page.brightness;
    labelBrightness.textContent = page.brightness;
    
    applyEnhanceSettings(true);
    hideLoading();
    switchView('enhance');
  }).catch(err => {
    hideLoading();
    alert('Error loading cropped image: ' + err.message);
  });
}

function applyEnhanceSettings(isPreview = true) {
  if (isPreview) {
    const page = state.pages[state.currentPageIndex];
    const canvas = enhanceEditorState.previewCanvas;
    if (!canvas) return;
    
    if (page.mode === 'scan') {
      const enhancedSrc = flatfieldEnhance(canvas, page.brightness, 15);
      enhancePreview.src = enhancedSrc;
    } else {
      enhancePreview.src = page.croppedSrc;
    }
  } else {
    showLoading('Applying final enhancements...');
    setTimeout(() => {
      try {
        const page = state.pages[state.currentPageIndex];
        const img = enhanceEditorState.img;
        
        if (page.mode === 'scan') {
          const enhancedSrc = flatfieldEnhance(img, page.brightness, 15);
          page.enhancedSrc = enhancedSrc;
        } else {
          page.enhancedSrc = page.croppedSrc;
        }
        
        hideLoading();
        switchView('gallery');
        renderPagesGrid();
      } catch(err) {
        hideLoading();
        alert('Error saving enhancements: ' + err.message);
      }
    }, 50);
  }
}

const sliderBrightness = document.getElementById('slider-brightness');
let isEnhancingPreview = false;
let pendingEnhanceUpdate = false;

function requestPreviewEnhance() {
  if (isEnhancingPreview) {
    pendingEnhanceUpdate = true;
    return;
  }
  
  isEnhancingPreview = true;
  pendingEnhanceUpdate = false;
  
  requestAnimationFrame(() => {
    applyEnhanceSettings(true);
    isEnhancingPreview = false;
    if (pendingEnhanceUpdate) {
      requestPreviewEnhance();
    }
  });
}

sliderBrightness.addEventListener('input', (e) => {
  document.getElementById('label-brightness').textContent = e.target.value;
  const page = state.pages[state.currentPageIndex];
  page.brightness = parseInt(e.target.value);
  requestPreviewEnhance();
});

document.getElementById('tab-scan').addEventListener('click', () => {
  const page = state.pages[state.currentPageIndex];
  if (page.mode === 'scan') return;
  page.mode = 'scan';
  document.getElementById('tab-scan').classList.add('active');
  document.getElementById('tab-photo').classList.remove('active');
  document.getElementById('brightness-control').style.display = 'flex';
  applyEnhanceSettings(true);
});

document.getElementById('tab-photo').addEventListener('click', () => {
  const page = state.pages[state.currentPageIndex];
  if (page.mode === 'photo') return;
  page.mode = 'photo';
  document.getElementById('tab-photo').classList.add('active');
  document.getElementById('tab-scan').classList.remove('active');
  document.getElementById('brightness-control').style.display = 'none';
  applyEnhanceSettings(true);
});

document.getElementById('btn-enhance-back').addEventListener('click', () => {
  const page = state.pages[state.currentPageIndex];
  initCropEditor(page.originalSrc, page.rotation, page.corners);
});

document.getElementById('btn-enhance-save').addEventListener('click', () => {
  applyEnhanceSettings(false);
});

// --- Gallery / Main Dashboard Logic ---

function readLocalFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve(e.target.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// Handle imported files with full batch processing automation
async function handleFilesSelected(files) {
  if (!files || files.length === 0) return;
  
  const fileArray = Array.from(files);
  const total = fileArray.length;
  showLoading(`Processing file 1 of ${total}...`);
  
  for (let i = 0; i < total; i++) {
    showLoading(`Processing file ${i + 1} of ${total}...`);
    try {
      const src = await readLocalFile(fileArray[i]);
      const img = await loadImage(src);
      
      // 1. Auto-detect borders
      const corners = autoDetectPaperCorners(img);
      
      // 2. Perform perspective warp (flatten)
      const [p0, p1, p2, p3] = corners;
      const topWidth = Math.hypot(p1.x - p0.x, p1.y - p0.y);
      const bottomWidth = Math.hypot(p2.x - p3.x, p2.y - p3.y);
      const leftHeight = Math.hypot(p3.x - p0.x, p3.y - p0.y);
      const rightHeight = Math.hypot(p2.x - p1.x, p2.y - p1.y);
      
      const targetW = Math.round(Math.max(topWidth, bottomWidth));
      const targetH = Math.round(Math.max(leftHeight, rightHeight));
      
      const croppedSrc = bilinearWarp(img, corners, targetW, targetH);
      
      // 3. Flatfield illumination correction
      const croppedImg = await loadImage(croppedSrc);
      const enhancedSrc = flatfieldEnhance(croppedImg, 220, 15);
      
      const newPage = {
        id: Date.now() + Math.random().toString(36).substr(2, 5),
        originalSrc: src,
        croppedSrc: croppedSrc,
        enhancedSrc: enhancedSrc,
        corners: corners,
        rotation: 0,
        mode: 'scan',
        brightness: 220
      };
      
      state.pages.push(newPage);
    } catch(err) {
      alert(`Error batch processing file ${i + 1}: ` + err.message);
    }
  }
  
  hideLoading();
  renderPagesGrid();
}

document.getElementById('btn-import').addEventListener('change', (e) => {
  handleFilesSelected(e.target.files);
  e.target.value = '';
});

document.getElementById('btn-capture').addEventListener('change', (e) => {
  handleFilesSelected(e.target.files);
  e.target.value = '';
});

// Render the pages grid
function renderPagesGrid() {
  pagesGrid.innerHTML = '';
  
  if (state.pages.length === 0) {
    emptyState.style.display = 'flex';
    pagesGrid.style.display = 'none';
    document.getElementById('btn-export').classList.add('disabled');
    document.getElementById('btn-export').disabled = true;
    return;
  }
  
  emptyState.style.display = 'none';
  pagesGrid.style.display = 'grid';
  document.getElementById('btn-export').classList.remove('disabled');
  document.getElementById('btn-export').disabled = false;

  state.pages.forEach((page, idx) => {
    const card = document.createElement('div');
    card.className = 'page-card';
    card.draggable = true;
    
    // Drag/drop re-ordering
    card.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', idx);
      card.classList.add('dragging');
    });
    
    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
    });
    
    card.addEventListener('dragover', (e) => {
      e.preventDefault();
    });
    
    card.addEventListener('drop', (e) => {
      e.preventDefault();
      const fromIdx = parseInt(e.dataTransfer.getData('text/plain'));
      const toIdx = idx;
      if (fromIdx !== toIdx) {
        const movedItem = state.pages.splice(fromIdx, 1)[0];
        state.pages.splice(toIdx, 0, movedItem);
        renderPagesGrid();
      }
    });

    card.innerHTML = `
      <div class="card-preview">
        <img src="${page.enhancedSrc}" alt="Page ${idx + 1}">
        <span class="card-badge">Page ${idx + 1}</span>
      </div>
      <div class="card-actions">
        <button class="card-btn edit">📐 Crop</button>
        <button class="card-btn replace">🔄 Replace</button>
        <button class="card-btn delete">🗑 Delete</button>
      </div>
    `;
    
    card.querySelector('.edit').addEventListener('click', (e) => {
      e.stopPropagation();
      state.currentPageIndex = idx;
      initCropEditor(page.originalSrc, page.rotation, page.corners);
    });
    
    // Replace logic: allows replacing this specific index with a new image and processes it
    card.querySelector('.replace').addEventListener('click', (e) => {
      e.stopPropagation();
      
      const replaceInput = document.createElement('input');
      replaceInput.type = 'file';
      replaceInput.accept = 'image/*';
      replaceInput.style.display = 'none';
      
      replaceInput.addEventListener('change', async (event) => {
        const file = event.target.files[0];
        if (!file) return;
        
        showLoading('Replacing and processing page...');
        try {
          const src = await readLocalFile(file);
          const img = await loadImage(src);
          
          // Auto detect and process replacement page
          const corners = autoDetectPaperCorners(img);
          const [p0, p1, p2, p3] = corners;
          const topWidth = Math.hypot(p1.x - p0.x, p1.y - p0.y);
          const bottomWidth = Math.hypot(p2.x - p3.x, p2.y - p3.y);
          const leftHeight = Math.hypot(p3.x - p0.x, p3.y - p0.y);
          const rightHeight = Math.hypot(p2.x - p1.x, p2.y - p1.y);
          
          const targetW = Math.round(Math.max(topWidth, bottomWidth));
          const targetH = Math.round(Math.max(leftHeight, rightHeight));
          
          const croppedSrc = bilinearWarp(img, corners, targetW, targetH);
          const croppedImg = await loadImage(croppedSrc);
          const enhancedSrc = flatfieldEnhance(croppedImg, 220, 15);
          
          // Update in-place
          page.originalSrc = src;
          page.croppedSrc = croppedSrc;
          page.enhancedSrc = enhancedSrc;
          page.corners = corners;
          page.rotation = 0;
          page.mode = 'scan';
          page.brightness = 220;
          
          renderPagesGrid();
          
          // Open editor immediately to let them fine-tune corners if needed
          state.currentPageIndex = idx;
          initCropEditor(src, 0, corners);
        } catch(err) {
          alert('Failed to replace page: ' + err.message);
        } finally {
          hideLoading();
          replaceInput.remove();
        }
      });
      
      document.body.appendChild(replaceInput);
      replaceInput.click();
    });
    
    card.querySelector('.delete').addEventListener('click', (e) => {
      e.stopPropagation();
      if (confirm(`Are you sure you want to delete Page ${idx + 1}?`)) {
        state.pages.splice(idx, 1);
        renderPagesGrid();
      }
    });
    
    card.addEventListener('click', () => {
      state.currentPageIndex = idx;
      initEnhanceEditor(page.croppedSrc);
    });

    pagesGrid.appendChild(card);
  });
}

// Generate PDF & Share
document.getElementById('btn-export').addEventListener('click', async () => {
  if (state.pages.length === 0) return;
  
  showLoading('Generating PDF...');
  
  setTimeout(async () => {
    try {
      const { jsPDF } = window.jspdf;
      const doc = new jsPDF('p', 'pt', 'a4');
      
      for (let i = 0; i < state.pages.length; i++) {
        const page = state.pages[i];
        const img = await loadImage(page.enhancedSrc);
        
        if (i > 0) {
          doc.addPage();
        }
        
        const iw = img.naturalWidth;
        const ih = img.naturalHeight;
        
        const margin = 20;
        const maxW = 595 - margin * 2;
        const maxH = 842 - margin * 2;
        
        const scale = Math.min(maxW / iw, maxH / ih);
        const w = iw * scale;
        const h = ih * scale;
        
        const x = margin + (maxW - w) / 2;
        const y = margin + (maxH - h) / 2;
        
        doc.addImage(page.enhancedSrc, 'JPEG', x, y, w, h);
      }
      
      const pdfBlob = doc.output('blob');
      const file = new File([pdfBlob], "Scanned_Document.pdf", { type: "application/pdf" });
      
      hideLoading();
      
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({
          files: [file],
          title: 'Scanned Document',
          text: 'Here is your compiled scanned document.'
        });
      } else {
        doc.save('Scanned_Document.pdf');
      }
    } catch(err) {
      hideLoading();
      alert('Failed to generate/share PDF: ' + err.message);
    }
  }, 100);
});

renderPagesGrid();
