/**
 * 批量获取学校和企业的经纬度坐标
 * 使用高德地图 Geocoding API
 * 免费配额：每天 5000 次
 */

const https = require('https');
const fs = require('fs');

const AMAP_KEY = '3d9c04680e4e1a9e62dcda1f1c6a49ec';

function httpsGet(url) {
    return new Promise((resolve, reject) => {
        https.get(url, res => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch (e) { reject(e); }
            });
        }).on('error', reject);
    });
}

async function geocodeAddress(address) {
    if (!address) return null;
    try {
        const url = `https://restapi.amap.com/v3/geocode/geo?address=${encodeURIComponent(address)}&key=${AMAP_KEY}`;
        const data = await httpsGet(url);
        if (data.status === '1' && data.geocodes && data.geocodes.length > 0) {
            const loc = data.geocodes[0].location.split(',');
            return { lng: parseFloat(loc[0]), lat: parseFloat(loc[1]) };
        }
    } catch (e) {
        console.error('Geocoding error for', address, e.message);
    }
    return null;
}

async function processFile(filename, idField = 'id') {
    const filepath = `server/data/${filename}`;
    const data = JSON.parse(fs.readFileSync(filepath, 'utf8'));
    let updated = 0;
    let skipped = 0;
    let failed = 0;

    for (const item of data) {
        // 已有坐标则跳过
        if (item.lng && item.lat) {
            skipped++;
            continue;
        }

        const address = item.address || item.foodLicenseAddress;
        if (!address) {
            console.log(`  [SKIP] ${item.name || item.id} - 无地址字段`);
            skipped++;
            continue;
        }

        process.stdout.write(`  获取坐标: ${item.name || item.id} (${address}) ... `);
        const coords = await geocodeAddress(address);

        if (coords) {
            item.lng = coords.lng.toString();
            item.lat = coords.lat.toString();
            console.log(`✓ ${coords.lng}, ${coords.lat}`);
            updated++;
        } else {
            console.log(`✗ 失败`);
            failed++;
        }

        // 高德免费配额有限，添加小延迟避免触发限制
        await new Promise(r => setTimeout(r, 200));
    }

    fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
    console.log(`\n${filename}: 更新${updated}条, 跳过${skipped}条, 失败${failed}条`);
    return { updated, skipped, failed };
}

async function main() {
    console.log('========================================');
    console.log('  批量获取经纬度坐标');
    console.log('  高德地图 Geocoding API');
    console.log('========================================\n');

    console.log('--- 学校数据 ---');
    await processFile('schools.json');

    console.log('\n--- 食材供应商 ---');
    await processFile('ingredientSuppliers.json');

    console.log('\n--- 校外供餐企业 ---');
    await processFile('cateringCompanies.json');

    console.log('\n--- 委托经营企业 ---');
    await processFile('operationSuppliers.json');

    console.log('\n--- 服务供应商 ---');
    await processFile('serviceSuppliers.json');

    console.log('\n完成！');
}

main().catch(console.error);