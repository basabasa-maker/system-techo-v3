// 添付の転送・画像縮小・既存キャッシュ。画面とメモ本文は扱わない。
import * as gas from "../gas-client.js";

const attMem = new Map();
let pendingUploads = 0;
export function hasPendingUploads() { return pendingUploads > 0; }

export async function uploadFile(file) {
  pendingUploads++;
  try { return await uploadFileContents(file); }
  finally { pendingUploads--; }
}

async function uploadFileContents(file) {
  let blob = file;
  let name = file.name || "file";
  let mime = file.type || "application/octet-stream";
  if (/^image\//.test(mime) && mime !== "image/gif") {
    blob = await downscaleImage(file, 1280, 0.72);
    mime = "image/jpeg";
    if (!/\.jpe?g$/i.test(name)) name = name.replace(/\.[^.]*$/, "") + ".jpg";
    if (!name || name === ".jpg") name = "image.jpg";
  }
  if (blob.size > 3 * 1024 * 1024) throw new Error("大きすぎます（3MBまで）");
  const b64 = await blobToBase64(blob);
  const res = await gas.pushMemoAttach(name, mime, b64);
  attMem.set(res.id, URL.createObjectURL(blob));
  return { id: res.id, name: res.name || name, mime: res.mime || mime };
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] || "");
    r.onerror = () => reject(new Error("読み込めません"));
    r.readAsDataURL(blob);
  });
}

function downscaleImage(file, maxSide, quality) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, maxSide / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * k);
      c.height = Math.round(img.height * k);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      c.toBlob((b) => (b ? resolve(b) : reject(new Error("画像を変換できません"))), "image/jpeg", quality);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("画像を読めません"));
    };
    img.src = url;
  });
}

// 一度読んだ添付は端末にも控える（次回から通信しない）
export async function loadAttachment(a) {
  if (attMem.has(a.id)) return attMem.get(a.id);
  const key = "/_att/" + a.id;
  try {
    if (window.caches) {
      const cache = await caches.open("sth-att");
      const hit = await cache.match(key);
      if (hit) {
        const url = URL.createObjectURL(await hit.blob());
        attMem.set(a.id, url);
        return url;
      }
    }
  } catch (e) {
    /* 控えが使えなくても続ける */
  }
  const data = await gas.pullMemoAttach(a.id);
  const bin = atob(data.data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const blob = new Blob([bytes], { type: data.mime || a.mime });
  try {
    if (window.caches) {
      const cache = await caches.open("sth-att");
      await cache.put(key, new Response(blob, { headers: { "Content-Type": blob.type } }));
    }
  } catch (e) {
    /* ignore */
  }
  const url = URL.createObjectURL(blob);
  attMem.set(a.id, url);
  return url;
}
