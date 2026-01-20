// setup.js - Improved version
const os = require('os');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const PORT = 3000;  // Configurable
const CONFIG_PATH = path.join(__dirname, 'assets/js/config.js');

function getNetworkIP() {
    const interfaces = os.networkInterfaces();
    
    // Priority order: 192.168.x.x > 10.x.x.x > other IPv4
    let priorityIP = null;
    let fallbackIP = null;
    
    for (const ifaceName in interfaces) {
        for (const iface of interfaces[ifaceName]) {
            if (iface.internal || iface.family !== 'IPv4') continue;
            
            const ip = iface.address;
            
            if (ip.startsWith('192.168.')) {
                return ip; // Highest priority
            } else if (ip.startsWith('10.')) {
                priorityIP = ip; // Second priority
            } else if (!fallbackIP) {
                fallbackIP = ip; // Any other IPv4
            }
        }
    }
    
    return priorityIP || fallbackIP || 'localhost';
}

function validateConfigFile(content) {
    if (!content.includes('CONFIG = {')) {
        console.error('❌ File config.js tidak memiliki object CONFIG');
        return false;
    }
    
    if (!content.includes('SERVER_URL:')) {
        console.error('❌ Tidak menemukan SERVER_URL dalam config.js');
        return false;
    }
    
    return true;
}

function updateConfigFile(ip) {
    if (!fs.existsSync(CONFIG_PATH)) {
        console.error(`❌ File config.js tidak ditemukan di: ${CONFIG_PATH}`);
        console.log('📁 Current directory:', __dirname);
        return false;
    }
    
    let content = fs.readFileSync(CONFIG_PATH, 'utf8');
    
    if (!validateConfigFile(content)) {
        console.log('\n⚠️  Struktur config.js mungkin berbeda.');
        console.log('Manual update required. Tambahkan:');
        console.log(`SERVER_URL: 'http://${ip}:${PORT}',`);
        return false;
    }
    
    // Pattern untuk SERVER_URL: getServerURL() atau string
    const pattern1 = /SERVER_URL:\s*getServerURL\(\)/g;
    const pattern2 = /SERVER_URL:\s*['"][^'"]*['"]/g;
    
    const newUrl = `SERVER_URL: 'http://${ip}:${PORT}'`;
    
    let updated = false;
    
    if (pattern1.test(content)) {
        // Ganti getServerURL() dengan IP static
        content = content.replace(pattern1, newUrl);
        updated = true;
    } else if (pattern2.test(content)) {
        // Ganti URL yang sudah ada
        content = content.replace(pattern2, newUrl);
        updated = true;
    } else {
        // Insert baru setelah MODE
        const insertPoint = content.indexOf('MODE:');
        if (insertPoint !== -1) {
            const lines = content.split('\n');
            for (let i = 0; i < lines.length; i++) {
                if (lines[i].includes('MODE:')) {
                    lines.splice(i + 1, 0, `    ${newUrl},`);
                    break;
                }
            }
            content = lines.join('\n');
            updated = true;
        }
    }
    
    if (updated) {
        fs.writeFileSync(CONFIG_PATH, content, 'utf8');
        console.log(`✅ Config.js berhasil diupdate dengan IP: ${ip}`);
        
        // Verify change
        const verifyContent = fs.readFileSync(CONFIG_PATH, 'utf8');
        if (verifyContent.includes(`'http://${ip}:${PORT}'`)) {
            console.log('✅ Verifikasi: IP berhasil ditambahkan ke config.js');
        }
    } else {
        console.error('❌ Gagal mengupdate config.js');
        console.log('Manual update required. Ubah SERVER_URL menjadi:');
        console.log(newUrl);
    }
    
    return updated;
}

function displayNetworkInfo(ip) {
    console.log('\n🌐 KONFIGURASI JARINGAN');
    console.log('='.repeat(40));
    console.log(`📡 IP Address terdeteksi: ${ip}`);
    console.log(`🔌 Port: ${PORT}`);
    console.log('\n📋 URL Akses:');
    console.log(`   Sprinter Login:  http://${ip}:${PORT}/sprinter`);
    console.log(`   Admin Dashboard: http://${ip}:${PORT}/admin`);
    console.log(`   QR Code Access:  http://${ip}:${PORT}/qrcode`);
    console.log('\n🔐 Login Demo:');
    console.log(`   Admin PIN: 1234`);
    console.log(`   Sprinter IDs: LH001, LH002, LH003`);
}

async function main() {
    console.clear();
    console.log(`
╔══════════════════════════════════════════════════════════╗
║       J&T POD RETUR SYSTEM - NETWORK SETUP               ║
╚══════════════════════════════════════════════════════════╝
    `);
    
    const ip = getNetworkIP();
    displayNetworkInfo(ip);
    
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });
    
    const question = (query) => new Promise(resolve => {
        rl.question(query, resolve);
    });
    
    try {
        const useDetected = await question('\n📝 Gunakan IP yang terdeteksi? (y/n): ');
        
        if (useDetected.toLowerCase() === 'y') {
            const success = updateConfigFile(ip);
            if (success) {
                console.log('\n🎯 SETUP BERHASIL!');
                console.log('='.repeat(30));
                console.log('🚀 Jalankan server dengan: node server.js');
                console.log(`📱 Akses dari HP: http://${ip}:${PORT}/sprinter`);
            }
        } else {
            const manualIP = await question('Masukkan IP manual (contoh: 192.168.1.100): ');
            const cleanIP = manualIP.trim();
            
            if (cleanIP && (cleanIP.includes('.') || cleanIP === 'localhost')) {
                const success = updateConfigFile(cleanIP);
                if (success) {
                    console.log('\n🎯 SETUP BERHASIL!');
                    console.log(`📱 Server akan berjalan di: http://${cleanIP}:${PORT}`);
                }
            } else {
                console.error('❌ IP tidak valid. Setup dibatalkan.');
            }
        }
    } catch (error) {
        console.error('❌ Setup error:', error.message);
    } finally {
        rl.close();
    }
}

// Run setup
if (require.main === module) {
    main().catch(console.error);
}

module.exports = { getNetworkIP, updateConfigFile };