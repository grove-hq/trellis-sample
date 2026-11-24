## Trellis

This repo uses [Trellis](https://github.com/grove-hq/trellis). A few files, called the frame, hold the rules the rest of the code relies on, and only their owner can change them.

The block between `# trellis:frame-begin` and `# trellis:frame-end` in `.github/CODEOWNERS` lists the frame. You can change a file in it, and the pull request's `Trellis` check then stays red until that file's owner signs the change. If you are changing one to get a check to pass, fix the code instead.
