/**
 * Test Image Deletion
 * Tests deleting an image and verifying it's gone from the API
 */

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:1435';

console.log('Image Deletion API Test');
console.log('==================================================');
console.log(`Backend URL: ${BACKEND_URL}\n`);

async function runTest() {
    try {
        // 1. Get an image ID
        process.stdout.write('1. Fetching first image from gallery... ');
        const listResponse = await fetch(`${BACKEND_URL}/api/cam/images?limit=1`);
        const listData = await listResponse.json();

        if (!listData.ok || listData.images.length === 0) {
            console.log('⚠️ SKIPPED (no images available to delete)');
            return;
        }

        const imageId = listData.images[0].id;
        console.log(`✅ Found ID: ${imageId}`);

        // 2. Delete the image
        process.stdout.write(`2. Deleting image ${imageId}... `);
        const deleteResponse = await fetch(`${BACKEND_URL}/api/cam/images/${imageId}`, {
            method: 'DELETE'
        });
        const deleteData = await deleteResponse.json();

        if (deleteResponse.ok && deleteData.ok) {
            console.log('✅ PASSED');
        } else {
            console.log('❌ FAILED');
            console.log(`   Status: ${deleteResponse.status}`);
            console.log(`   Response:`, deleteData);
            process.exit(1);
        }

        // 3. Verify it's gone
        process.stdout.write('3. Verifying image is gone... ');
        const getResponse = await fetch(`${BACKEND_URL}/api/cam/images/${imageId}`);
        const getData = await getResponse.json();

        if (getResponse.status === 404 && !getData.ok) {
            console.log('✅ PASSED (404 Not Found as expected)');
        } else {
            console.log('❌ FAILED');
            console.log(`   Status: ${getResponse.status}`);
            console.log(`   Response:`, getData);
            process.exit(1);
        }

        console.log('\n==================================================');
        console.log('✅ Image Deletion test completed successfully!');
    } catch (error) {
        console.log('\n❌ ERROR during test:');
        console.error(error);
        process.exit(1);
    }
}

runTest();
