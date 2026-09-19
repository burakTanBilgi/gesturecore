# Head fixtures

`canonical-face.json` is the 468 vertices of MediaPipe's canonical face model
(`mediapipe/modules/face_geometry/data/canonical_face_model.obj`, Apache-2.0), as
`[x, y, z]` in centimetres: +x toward the face's left, +y up, +z out of the face. It is
the mean face the Face Mesh topology is built on, so its vertex *i* is landmark *i*.

The tests turn, tilt, open and close it to make faces with exactly known angles and
eyes (`helpers.ts`), and project them into a frame the way a tracker reports landmarks.
Nothing here is a recording of a real person.
