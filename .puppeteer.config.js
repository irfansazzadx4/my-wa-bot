/**
 * Puppeteer config — Chrome কে project folder এ রাখো
 * যাতে Render এর disk এ persist থাকে
 */
module.exports = {
    cacheDirectory: "/opt/render/project/src/.puppeteer-cache",
};
