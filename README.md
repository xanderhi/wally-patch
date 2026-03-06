# wally-patch
A vibecoded JS script to wrap all GetService, service, etc calls with cloneref, replace all script and script.Parent references with their file paths, fix typing issues and react issues when trying to use Wally while bundling with darklua.
When I have more time this will be rewritten with Lune and without the help of sir Claude.

## How to use
You can manually set the file paths in the files themselves. Otherwise, follow this.

In your project folder, make a new folder called scripts. Inside that folder create another folder called whatever you'd like. Drag the files from this repo into there.

Everytime you add a package, run refresh.bat and use "reload developer window" in visual studio code.

This also renames the _index folder inside Packages to index, due to some issue occurring with darklua.
