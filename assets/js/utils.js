// utils.js - Utility functions for J&T POD System (Final Safe)
class Utils {
  // ================= FILE VALIDATION =================
  static validateFile(file) {
    if (file.size > CONFIG.MAX_FILE_SIZE) {
      return {
        valid: false,
        message: `File terlalu besar (max ${CONFIG.MAX_FILE_SIZE / 1024 / 1024}MB)`,
      };
    }

    if (!CONFIG.ALLOWED_FILE_TYPES.includes(file.type)) {
      return { valid: false, message: "Format file tidak didukung. Gunakan JPG atau PNG" };
    }

    return { valid: true };
  }

  static formatFileSize(bytes) {
    if (bytes === 0) return "0 Bytes";
    const k = 1024;
    const sizes = ["Bytes", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
  }

  static fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => resolve(e.target.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  static downloadFile(base64Data, filename) {
    try {
      const link = document.createElement("a");
      link.href = base64Data;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } catch (err) {
      Utils.showNotification("Gagal download file", "error");
      console.error(err);
    }
  }

  // ================= IMAGE MERGE =================
  static async mergeImages(imagesDataUrls) {
    return new Promise((resolve, reject) => {
      if (!imagesDataUrls || imagesDataUrls.length === 0) {
        reject(new Error("Tidak ada gambar untuk digabung"));
        return;
      }

      const images = [];
      let loadedCount = 0;

      imagesDataUrls.forEach((dataUrl, index) => {
        const img = new Image();

        img.onload = () => {
          loadedCount++;

          // Resize height jika terlalu tinggi
          if (img.height > CONFIG.MERGE_CONFIG.imageMaxHeight) {
            const ratio = CONFIG.MERGE_CONFIG.imageMaxHeight / img.height;
            img.width *= ratio;
            img.height = CONFIG.MERGE_CONFIG.imageMaxHeight;
          }

          if (loadedCount === imagesDataUrls.length) {
            const canvas = document.createElement("canvas");
            const ctx = canvas.getContext("2d");

            const totalWidth =
              images.reduce((sum, im) => sum + im.width, 0) +
              (images.length - 1) * CONFIG.MERGE_CONFIG.spacing;

            const maxHeight = Math.max(...images.map((im) => im.height));

            canvas.width = Math.min(totalWidth, CONFIG.MERGE_CONFIG.maxWidth);
            canvas.height = Math.min(maxHeight, CONFIG.MERGE_CONFIG.maxHeight);

            // Background
            ctx.fillStyle = CONFIG.MERGE_CONFIG.backgroundColor;
            ctx.fillRect(0, 0, canvas.width, canvas.height);

            // Draw images
            let xPos = 0;
            const scale = canvas.width / totalWidth;

            images.forEach((im) => {
              const scaledWidth = im.width * scale;
              const scaledHeight = im.height * scale;
              const yPos = (canvas.height - scaledHeight) / 2;

              ctx.drawImage(im, xPos, yPos, scaledWidth, scaledHeight);
              xPos += scaledWidth + CONFIG.MERGE_CONFIG.spacing * scale;
            });

            resolve({
              dataUrl: canvas.toDataURL("image/jpeg", 0.9),
              width: canvas.width,
              height: canvas.height,
            });
          }
        };

        img.onerror = () => reject(new Error("Gagal memuat salah satu gambar"));
        img.src = dataUrl;
        images[index] = img;
      });
    });
  }

  // ================= VALIDATION =================
  static validateAWB(awb) {
    if (!awb) return { valid: false, message: "AWB tidak boleh kosong" };
    if (!CONFIG.AWB_REGEX.test(awb)) return { valid: false, message: "Format AWB tidak valid" };
    return { valid: true };
  }

  static validateSprinterId(sprinterId) {
    if (!sprinterId) return { valid: false, message: "ID Sprinter tidak boleh kosong" };

    const formattedId = sprinterId.toUpperCase().trim();
    if (!CONFIG.SPRINTER_ID_REGEX.test(formattedId)) {
      return { valid: false, message: "Format ID Sprinter tidak valid (contoh: LS0000009547)" };
    }

    return { valid: true, formattedId };
  }

  // ================= LOCAL STORAGE =================
  static saveToLocalStorage(key, data) {
    try {
      localStorage.setItem(key, JSON.stringify(data));
      return true;
    } catch (error) {
      console.error("LocalStorage save error:", error);
      return false;
    }
  }

  static loadFromLocalStorage(key, defaultValue = null) {
    try {
      const data = localStorage.getItem(key);
      return data ? JSON.parse(data) : defaultValue;
    } catch (error) {
      console.error("LocalStorage load error:", error);
      return defaultValue;
    }
  }

  // ================= UI =================
  static showNotification(message, type = "info") {
    const existing = document.getElementById("global-notification");
    if (existing) existing.remove();

    const notification = document.createElement("div");
    notification.id = "global-notification";
    notification.style.cssText = `
      position:fixed;
      top:20px;
      right:20px;
      padding:15px 20px;
      border-radius:8px;
      color:white;
      z-index:9999;
      box-shadow:0 4px 12px rgba(0,0,0,0.15);
      background:${
        type === "success"
          ? "#28a745"
          : type === "error"
          ? "#dc3545"
          : type === "warning"
          ? "#ffc107"
          : "#17a2b8"
      };
    `;
    notification.textContent = message;

    document.body.appendChild(notification);

    setTimeout(() => notification.remove(), 4000);
  }

  static formatDate(dateString, includeTime = true) {
    const date = new Date(dateString);
    let formatted = date.toLocaleDateString("id-ID", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });

    if (includeTime) {
      formatted +=
        " " +
        date.toLocaleTimeString("id-ID", {
          hour: "2-digit",
          minute: "2-digit",
        });
    }

    return formatted;
  }

  // ================= API HELPER =================
  static async fetchWithAuth(url, options = {}) {
    const user = Utils.loadFromLocalStorage("jt_sprinter_user");
    // NOTE: nama key masih jt_device_id, tapi isinya sekarang SESSION TOKEN
    const sessionToken = Utils.loadFromLocalStorage("jt_device_id");

    if (user && sessionToken) {
      options.headers = {
        "Content-Type": "application/json",
        ...options.headers,
        "X-User-ID": user.id,
        "X-Device-ID": sessionToken,
      };
    }

    const response = await fetch(url, options);

    if (response.status === 401) {
      Utils.showNotification("Session berakhir. Silakan login ulang.", "warning");
      setTimeout(() => window.location.reload(), 1500);
      throw new Error("Session expired");
    }

    return response;
  }
}

window.Utils = Utils;
