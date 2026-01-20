# Engineering History — Control Tower System

Dokumen ini adalah **catatan teknis historis** pengembangan Control Tower.
Semua entri ditulis berbasis **fakta yang terjadi**, bukan asumsi.

Tujuan dokumen:
- Menjadi memori teknis proyek (seperti Git, tapi naratif)
- Mencegah pengulangan error & keputusan
- Menjadi konteks saat membuka chat / sesi baru
- Tidak bergantung pada ChatGPT sebagai runtime

---

## Aturan Penulisan (WAJIB KONSISTEN)

- Satu entri = satu masalah / satu keputusan
- Ditulis setelah masalah **selesai atau dihentikan**
- Tidak mengubah histori lama (append-only)
- Jika ada perubahan kode → **sebutkan file & fungsi**
- Jika ada revisi keputusan → buat entri baru (jangan edit lama)

---

## Template Entri Histori

> Gunakan format ini untuk SETIAP entri baru

---

## [YYYY-MM-DD] — Judul Masalah / Keputusan

### Konteks Awal
- Kondisi sistem saat itu
- Tujuan yang ingin dicapai
- Batasan yang disepakati (contoh: tanpa refactor, tanpa ubah runtime)

### Masalah yang Terjadi
- Gejala nyata (error message, behavior, output)
- Di mana terjadi (Git, Windows, Server, Browser, dll)

### Analisis Akar Masalah
- Fakta yang ditemukan
- Hal yang dipastikan BUKAN penyebab
- Kesimpulan teknis

### Keputusan / Solusi
- Solusi yang dipilih
- Alasan teknis pemilihan solusi
- Solusi lain yang ditolak (jika ada)

### Perubahan Teknis
- File yang terlibat:
  - `path/file.js`
- Catatan perubahan:
  - (contoh: pemindahan file, penyesuaian path, dll)
- Catatan penting:
  - (contoh: TIDAK ada refactor logika)

### Dampak & Catatan Masa Depan
- Dampak positif
- Risiko yang dihindari
- Hal yang perlu diingat di masa depan

### Status
- ✅ Selesai / ⏳ Ongoing / ❌ Dibatalkan

---

## Daftar Entri (Index)

> Tambahkan link internal jika sudah banyak entri

- (belum ada)
