# wally-patch
A vibecoded JS script to wrap all GetService, service, etc calls with cloneref, replace all script and script.Parent references with their file paths, fix typing issues and react issues.
When I have more time this will be rewritten with Lune and without the help of sir Claude.

## How to use
You can manually set the file paths in the files themselves. Otherwise, follow this.\n
In your project folder, make a new folder called scripts. Inside that folder create another folder called whatever you'd like. Drag the files from this repo into there.\n
Everytime you add a package, run refresh.bat and use "reload developer window" in VSC.
