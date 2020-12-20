const Table = require('cli-table');
const Filesize = require('filesize');
const tachyon = require('../index');
const fs = require('fs');

let images = fs.readdirSync( __dirname + '/images' );

const args = process.argv.slice(2);

if ( args[0] && args[0].indexOf( '--' ) !== 0 ) {
	images = images.filter( file => args[0] === file );
}

const saveFixtured = args.indexOf( '--update-fixtures' ) > -1;

const table = new Table({
	head: [
		'Image',
		'Original Size',
		'Tachyon Size',
		'100px',
		'300px',
		'700px',
		'700px webp',
		'700px avif',
	],
	style: {
		compact: true,
	},
	colWidths: [15, 15, 20, 10, 10, 10, 15, 15],
});

// Read in existing features for resizes, so we can detect if image resizing
// has lead to a change in file size from previous runs.
const oldFixtures = JSON.parse( fs.readFileSync( __dirname + '/fixtures.json' ) );
const fixtures = {};

async function test() {
	await Promise.all(
		images.map(async imageName => {
			const image = `${__dirname}/images/${imageName}`;
			const imageData = fs.readFileSync(image);
			const original = await tachyon.resizeBuffer(imageData, {});
			const sizes = {
				original: {},
				small: { w: 100 },
				medium: { w: 300 },
				large: { w: 700 },
				webp: { w: 700, webp: true },
				avif: { w: 700, avif: true },
			};
			const promises = await Promise.all(
				Object.entries(sizes).map(async ([size, args]) => {
					return tachyon.resizeBuffer(imageData, args);
				})
			);

			// Zip tehm back into a size => image map.
			const resized = promises.reduce((images, image, index) => {
				images[Object.keys(sizes)[index]] = image;
				return images;
			}, {});

			// Save each one to the file system for viewing.
			Object.entries(resized).forEach(([size, image]) => {
				const imageKey = `${imageName}-${size}.${image.info.format == 'heif' ? 'avif' : image.info.format }`;
				fixtures[ imageKey ] = image.data.length;
				fs.writeFile( `${__dirname}/output/${imageKey}`, image.data, () => {});
			});

			table.push([
				imageName,
				Filesize(imageData.length, { round: 0 }),
				Filesize(resized.original.info.size, { round: 0 }) +
					' (' +
					Math.floor(resized.original.info.size / imageData.length * 100) +
					'%)',
				Filesize(resized.small.info.size, { round: 0 }),
				Filesize(resized.medium.info.size, { round: 0 }),
				Filesize(resized.large.info.size, { round: 0 }),
				Filesize(resized.webp.info.size, { round: 0 }) +
					' (' +
					Math.floor(resized.webp.info.size / resized.large.info.size * 100) +
					'%)',
				Filesize(resized.avif.info.size, { round: 0 }) +
				' (' +
				Math.floor(resized.avif.info.size / resized.large.info.size * 100) +
				'%)',
			]);

		})
	);

	if ( saveFixtured ) {
		fs.writeFileSync( __dirname + '/fixtures.json', JSON.stringify( fixtures, null, 4 ) );
	}

	console.log(table.toString());

	let exitCode = 0;
	for (const key in fixtures) {
		if ( ! oldFixtures[ key ] ) {
			exitCode = 1;
			console.error( `${ key } not found in existing fixtures.` );
		}
		if ( fixtures[ key ] > oldFixtures[ key ] ) {
			const diff = fixtures[ key ] / oldFixtures[ key ] * 100;
			exitCode = 1;
			console.error( `${ key } is larger than image in fixtures (${ fixtures[ key ] - oldFixtures[ key ] } bytes larger, ${ diff }%.)` );
		}

		if ( fixtures[ key ] < oldFixtures[ key ] ) {
			const diff = oldFixtures[ key ] / fixtures[ key ] * 100;
			console.log( `${ key } is smaller than image in fixtures (${ fixtures[ key ] - oldFixtures[ key ] } bytes smaller, ${ diff }%.)` );
		}
	}
	// Exit the script if the fixtures have changed in a negative direction. This means
	// TravisCI etc will detect the failure correctly.
	process.exit(exitCode);
}

test();
